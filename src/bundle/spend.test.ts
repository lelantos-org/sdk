import { beforeAll, describe, expect, it } from "vitest";
import { BN254_FR } from "../core/field.js";
import { randomBytes, randomFr, randomJubjubScalar } from "../core/random.js";
import { buildNoteCommitment } from "../crypto/commit.js";
import { diversifiedBase } from "../crypto/diversified-base.js";
import { Jubjub } from "../crypto/jubjub-wasm/index.js";
import { buildNullifierFromNsk } from "../crypto/nullifier.js";
import { Poseidon } from "../crypto/poseidon.js";
import { buildRho } from "../crypto/rho.js";
import { InvalidArgumentError } from "../errors/config.js";
import { fmdDiversifiedFlagKey } from "../fmd/diversified.js";
import { deriveDiversifiedPk } from "../keys/diversified.js";
import { diversifierToBytes } from "../keys/diversifier.js";
import { buildSpendingKey, type SpendingKey } from "../keys/keys.js";
import { buildOutputAux } from "../notes/aux.js";
import type { Note } from "../notes/note.js";
import { deriveOutgoingKey } from "../notes/outgoing.js";
import { deriveOutputSecret, expandSeed, seedFromSecret } from "../notes/seed.js";
import type { SpendKind } from "../protocol/transact.js";
import type { Prover } from "../prover/types.js";
import { emptyScanStats, scanNotes } from "../sync/scan.js";
import { padAddress, recipientAt, scanInputsOf } from "../test-utils/outputs.js";
import {
    type BuiltBundle,
    buildInputs,
    type InputSlot,
    type OutputRecipient,
    type OutputSpec,
    sealOutput,
} from "./common.js";
import { buildSpend, type SpendArgs } from "./spend.js";

// `kind` routes the on-chain call: a transfer tagged `withdrawNative` would reach
// NativeAdapter.withdrawNative and unwrap WETH to a recipient. It is a plain argument to the
// shared builder, so each kind is asserted here.

/** Records the witness instead of proving. */
function recordingProver(): Prover & { last?: Record<string, unknown> } {
    const p: Prover & { last?: Record<string, unknown> } = {
        async prove(input) {
            p.last = input;
            return {
                proof: {
                    pi_a: ["1", "2"],
                    pi_b: [["3", "4"]],
                    pi_c: ["5", "6"],
                    protocol: "groth16",
                    curve: "bn128",
                },
                publicSignals: [],
            };
        },
    };
    return p;
}

const ZERO = "0x0000000000000000000000000000000000000000";

/** Depth of every Merkle path here. */
const DEPTH = 4;

/** Diversifier of every real input slot. These tests record the witness, so any value serves. */
const D = (1n << 127n) + 5n;

/** The sender's outgoing key in tests that do not open what they seal. */
const OCK = randomBytes(32);

let P: Poseidon;
let J: Jubjub;
beforeAll(async () => {
    P = await Poseidon.build();
    J = await Jubjub.build();
});

function note(value: bigint, pk: bigint = randomFr(), asset = 1n): Note {
    return { asset, value, pk, rho: randomFr(), rcm: randomFr() };
}

/** A real input slot holding `spent` at leaf 0, under an all-zero path. */
function inputSlot(spent: Note, cached: Partial<InputSlot["cached"]> = {}): InputSlot {
    return {
        cached: { note: spent, nsk: randomJubjubScalar(), d: D, leafIndex: 0, ...cached },
        pathElements: Array.from({ length: DEPTH }, () => [0n, 0n, 0n]),
        pathIndices: Array.from({ length: DEPTH }, () => 0),
    };
}

/** The address of `key` at diversifier `index`, decoded. */
function addressOf(key: SpendingKey, index = 0): OutputRecipient {
    return recipientAt(P, J, key, index);
}

/** An address of a fresh account. */
function someAddress(): OutputRecipient {
    return addressOf(buildSpendingKey(P, randomJubjubScalar()));
}

const out = (value: bigint, recipient: OutputRecipient, asset = 1n): OutputSpec => ({
    asset,
    value,
    recipient,
});

/** A transfer of asset 1 on chain 31337 over `inputs` and `outputs`, recorded, not proven. */
function spendArgs(over: Pick<SpendArgs, "inputs" | "outputs"> & Partial<SpendArgs>): SpendArgs {
    return {
        P,
        J,
        kind: "transfer",
        chainId: 31337n,
        asset: 1n,
        payerAddress: ZERO,
        relayerAddress: ZERO,
        recipientAddress: ZERO,
        prover: recordingProver(),
        treeDepth: DEPTH,
        merkleRoot: 0n,
        outgoingKey: OCK,
        ...over,
    };
}

describe("buildSpend", () => {
    it("tags the payload with the kind it was given", async () => {
        const recipient = someAddress();
        const input = inputSlot(note(100n));

        const base = (
            kind: SpendKind,
            publicOut: bigint,
            outputs: [OutputSpec, OutputSpec],
        ): SpendArgs => spendArgs({ kind, inputs: [input, null], outputs, publicOut });

        for (const kind of ["transfer", "withdraw", "withdrawNative"] as SpendKind[]) {
            const publicOut = kind === "transfer" ? 0n : 40n;
            const outs: [OutputSpec, OutputSpec] = [
                out(100n - publicOut, recipient),
                out(0n, recipient),
            ];
            const built = await buildSpend(base(kind, publicOut, outs));

            expect(built.payload.kind).toBe(kind);
            expect(built.payload.pubInputs.publicOut).toBe(publicOut);
            // A transfer names no asset: the circuit forces `public_asset_id` to 0 with
            // `public_out`, and the pool reverts `MustNotNameAsset`.
            expect(built.payload.pubInputs.publicAssetId).toBe(kind === "transfer" ? 0n : 1n);
            expect(built.cm).toHaveLength(2);
            expect(built.payload.aux).toHaveLength(2);
            // Only `SwapWrapper.swap` reads `intentHash`; every other spend
            // binds and sends zero.
            expect(built.payload.pubInputs.intentHash).toBe(0n);
        }

        // A swap's leg 1 is a `withdraw` binding the swap intent's hash: a full field word,
        // well past 160 bits, carried through unmasked.
        const intentHash = BN254_FR - 1n;
        const outs: [OutputSpec, OutputSpec] = [out(60n, recipient), out(0n, recipient)];
        const swapLeg = await buildSpend({ ...base("withdraw", 40n, outs), intentHash });
        expect(swapLeg.payload.pubInputs.intentHash).toBe(intentHash);

        // Not a field element: the circuit would reduce it and bind a
        // different word than the contract compares.
        await expect(
            buildSpend({ ...base("withdraw", 40n, outs), intentHash: BN254_FR }),
        ).rejects.toBeInstanceOf(InvalidArgumentError);
    });

    it("rejects an unbalanced spend, naming the kind", async () => {
        const recipient = someAddress();
        const args = spendArgs({
            kind: "withdraw",
            inputs: [inputSlot(note(100n)), null],
            outputs: [out(90n, recipient), out(0n, recipient)],
            publicOut: 40n, // 90 + 40 != 100
        });

        await expect(buildSpend(args)).rejects.toThrow(/withdraw balance/);
    });

    it("requires at least one real input", async () => {
        const recipient = someAddress();

        await expect(
            buildSpend(
                spendArgs({
                    inputs: [null, null],
                    outputs: [out(0n, recipient), out(0n, recipient)],
                }),
            ),
        ).rejects.toThrow(/transfer: at least one real input/);
    });
});

describe("buildSpend pre-flight", () => {
    // Each of these builds a witness the prover accepts the shape of and then fails on, as an
    // opaque circom assertion or as a valid-looking proof the chain rejects. All are caught
    // before any artifact is fetched.

    function fixture() {
        const pk = randomFr();
        const recipient = someAddress();
        const slot = (): InputSlot => inputSlot(note(100n, pk));
        const args = (over: Partial<SpendArgs> = {}): SpendArgs =>
            spendArgs({
                inputs: [slot(), null],
                outputs: [out(100n, recipient), out(0n, recipient)],
                ...over,
            });

        return { pk, recipient, slot, args };
    }

    it("accepts a well-formed spend", async () => {
        const { args } = fixture();
        await expect(buildSpend(args())).resolves.toBeDefined();
    });

    // Mixing assets is legal (see "buildSpend, multi-asset" below); an asset that fails to
    // conserve is not. A mis-built selection takes two shapes: an input nothing spends, and an
    // output nothing funds.

    it("rejects an input whose asset no output accounts for", async () => {
        const { pk, slot, args } = fixture();
        const foreign = slot();
        foreign.cached.note = note(100n, pk, 7n);

        // Asset 7 enters and never leaves; asset 1 leaves without entering.
        await expect(buildSpend(args({ inputs: [foreign, null] }))).rejects.toThrow(
            /balance for asset 7: inputs exceed outputs/,
        );
    });

    it("rejects an output minting an asset no input supplied", async () => {
        const { recipient, args } = fixture();
        const outs = [out(100n, recipient, 9n), out(0n, recipient)];

        await expect(buildSpend(args({ outputs: outs }))).rejects.toThrow(
            /balance for asset 1: inputs exceed outputs/,
        );
    });

    it("rejects slot counts that do not match the named shape", async () => {
        const { args } = fixture();
        // A 2x2 witness against a 3x3 key has the wrong number of public inputs and a
        // different Fiat-Shamir `z`.
        await expect(buildSpend(args({ shape: { nIn: 3, nOut: 3 } }))).rejects.toThrow(
            /input slots for a 3x3 circuit/,
        );
    });

    it("accepts slot counts that do match the named shape", async () => {
        const { args } = fixture();
        await expect(buildSpend(args({ shape: { nIn: 2, nOut: 2 } }))).resolves.toBeDefined();
    });

    it("rejects a binary-shaped path from a mis-implemented relayer", async () => {
        // One sibling per level and indices 0/1: still builds a witness, but
        // proves against a root that is not the tree's.
        const { slot, args } = fixture();
        const binary = slot();
        binary.pathElements = Array.from({ length: 4 }, () => [0n]);

        await expect(buildSpend(args({ inputs: [binary, null] }))).rejects.toThrow(
            /1 siblings, expected 3/,
        );
    });

    it("rejects a path whose depth is not the tree's", async () => {
        const { slot, args } = fixture();
        const short = slot();
        short.pathElements = Array.from({ length: 2 }, () => [0n, 0n, 0n]);
        short.pathIndices = [0, 0];

        await expect(buildSpend(args({ inputs: [short, null] }))).rejects.toThrow(
            /2-level path .* depth-4 tree/,
        );
    });

    it("rejects an out-of-range path index", async () => {
        const { slot, args } = fixture();
        const bad = slot();
        bad.pathIndices = [0, 4, 0, 0];

        await expect(buildSpend(args({ inputs: [bad, null] }))).rejects.toThrow(
            /level 1 has index 4/,
        );
    });

    it("rejects a value wider than the circuit's 64-bit range check", async () => {
        const { pk, recipient, slot, args } = fixture();
        const huge = slot();
        huge.cached.note = note(1n << 64n, pk);

        await expect(
            buildSpend(
                args({
                    inputs: [huge, null],
                    outputs: [out(1n << 64n, recipient), out(0n, recipient)],
                }),
            ),
        ).rejects.toThrow(/64-bit unsigned integer/);
    });

    it("rejects a note under asset 0, which the circuit refuses even on a zero-value pad", async () => {
        const { recipient, args } = fixture();
        const pad = out(0n, recipient, 0n);

        await expect(buildSpend(args({ outputs: [out(100n, recipient), pad] }))).rejects.toThrow(
            /output slot 1 asset must not be 0/,
        );
    });
});

// Cross-asset fees: the circuit conserves value per asset (PerAssetValueBalance in
// circuits/src/lib/balance.circom), so one proof may carry the asset being moved alongside a
// second asset that pays the relayer. These pin that the SDK is no stricter than the circuit.
describe("buildSpend, multi-asset", () => {
    function fixture() {
        const pk = randomFr();
        const recipient = someAddress();

        const slot = (asset: bigint, value: bigint, leafIndex: number): InputSlot =>
            inputSlot(note(value, pk, asset), { leafIndex });

        const assetOut = (asset: bigint, value: bigint): OutputSpec => out(value, recipient, asset);

        const args = (
            inputs: SpendArgs["inputs"],
            outputs: OutputSpec[],
            publicOut = 0n,
        ): SpendArgs => spendArgs({ inputs, outputs, publicOut });

        return { slot, out: assetOut, args };
    }

    /// Move asset 1 and pay the relayer in asset 2.
    it("accepts a spend whose fee is paid in a second asset", async () => {
        const { slot, out, args } = fixture();
        const built = await buildSpend(
            args(
                [slot(1n, 100n, 0), slot(2n, 30n, 1)],
                // send 1, change 1, fee 2, change 2
                [out(1n, 70n), out(1n, 30n), out(2n, 25n), out(2n, 5n)],
            ),
        );
        expect(built.cm).toHaveLength(4);
    });

    /// Per-asset, not in aggregate. Asset 1 burns 5 and asset 2 mints 5, so the totals match:
    /// the cross-asset forgery `PerAssetValueBalance` rejects and a single global sum accepts.
    it("rejects an imbalance that a global sum would miss", async () => {
        const { slot, out, args } = fixture();
        const inputs = [slot(1n, 100n, 0), slot(2n, 30n, 1)];
        const outputs = [out(1n, 65n), out(1n, 30n), out(2n, 30n), out(2n, 5n)];

        // The premise: a global sum cannot tell these apart.
        const sumIn = inputs.reduce((t, s) => t + s.cached.note.value, 0n);
        const sumOut = outputs.reduce((t, o) => t + o.value, 0n);
        expect(sumIn).toBe(sumOut);

        await expect(buildSpend(args(inputs, outputs))).rejects.toThrow(/balance for asset/);
    });

    /// `publicOut` leaves the pool in the transparent bucket, which the circuit ties to a single
    /// `public_asset_id`. It must count against that asset only; charged to the fee asset, a
    /// withdraw would appear to balance while taking value from the fee.
    it("attributes publicOut to the transparent bucket's asset alone", async () => {
        const { slot, out, args } = fixture();
        const ok = args(
            [slot(1n, 100n, 0), slot(2n, 30n, 1)],
            // asset 1: 100 in = 40 publicOut + 60 out. asset 2: 30 = 25 + 5.
            [out(1n, 60n), out(2n, 25n), out(2n, 5n)],
            40n,
        );
        expect((await buildSpend({ ...ok, kind: "withdraw" })).cm).toHaveLength(3);

        // Same numbers, but asset 2 tries to absorb the publicOut.
        const bad = args(
            [slot(1n, 100n, 0), slot(2n, 30n, 1)],
            [out(1n, 100n), out(2n, 25n), out(2n, 5n)],
            40n,
        );
        await expect(buildSpend({ ...bad, kind: "withdraw" })).rejects.toThrow(/asset 1/);
    });
});

describe("buildInputs", () => {
    const real = (nsk: bigint): InputSlot => inputSlot(note(100n), { nsk });

    it("keys every dummy by the real input's nsk, under a fresh rho and rcm", () => {
        const nsk = randomJubjubScalar();

        // The real slot need not come first.
        const built = buildInputs(P, [null, real(nsk), null, null], DEPTH);
        const dummies = built.filter((s) => s.isDummy);

        expect(built.map((s) => s.isDummy)).toEqual([true, false, true, true]);
        for (const d of dummies) {
            expect(d.nsk).toBe(nsk);
            expect(d.nf).toBe(buildNullifierFromNsk(P, nsk, d.rho, d.cm));
            // Not the zero key, which every observer holds.
            expect(d.nf).not.toBe(buildNullifierFromNsk(P, 0n, d.rho, d.cm));
        }
        expect(new Set(dummies.map((d) => d.rho)).size).toBe(3);
        expect(new Set(dummies.map((d) => d.rcm)).size).toBe(3);
        expect(new Set(built.map((s) => s.nf)).size).toBe(4);
    });

    it("carries the slot's diversifier on a real input and zero on a dummy", () => {
        const built = buildInputs(P, [null, real(randomJubjubScalar()), null, null], DEPTH);

        expect(built.map((s) => s.d)).toEqual([0n, D, 0n, 0n]);
    });

    it("rejects slots with no real input", () => {
        expect(() => buildInputs(P, [null, null], DEPTH)).toThrow(InvalidArgumentError);
    });
});

describe("sealOutput", () => {
    const CHAIN = 31337n;
    /** The nullifiers of the spend the sealed output belongs to. */
    const NULLIFIERS = [0xa11n, 0xb22n];

    /** 7 units of asset 1 at a fresh `rho`, sealed by `OCK` in that spend; the recipient is open. */
    const unaddressed = () => ({
        outgoingKey: OCK,
        chainId: CHAIN,
        rho: randomFr(),
        asset: 1n,
        value: 7n,
        nullifiers: NULLIFIERS,
    });

    it("derives the note and its aux from the outgoing key, the output and the nullifiers", () => {
        const recipient = addressOf(buildSpendingKey(P, randomJubjubScalar()), 3);
        const o = unaddressed();

        const sealed = sealOutput(J, P, { ...o, recipient });

        const osk = deriveOutputSecret(OCK, {
            chainId: CHAIN,
            rho: o.rho,
            asset: 1n,
            value: 7n,
            d: diversifierToBytes(recipient.d),
            pk_d: J.packPoint(recipient.pk_d),
            pk: recipient.pk,
            ck_d: J.packPoint(recipient.ck_d),
            nullifiers: NULLIFIERS,
        });
        const rseed = seedFromSecret(osk);
        const { rcm, esk, fmdR } = expandSeed(rseed, o.rho);
        const gD = diversifiedBase(J, P, recipient.d);
        expect(sealed.note).toEqual({ asset: 1n, value: 7n, pk: recipient.pk, rho: o.rho, rcm });
        expect(sealed.aux).toEqual(
            buildOutputAux({
                J,
                P,
                recipientFlagKey: fmdDiversifiedFlagKey(J, P, recipient.ck_d, gD),
                recipientPkD: recipient.pk_d,
                gD,
                note: { asset: 1n, value: 7n, rho: o.rho, rseed, d: recipient.d },
                esk,
                fmdR,
            }),
        );
        expect(sealed.aux.aux.ephPub).toEqual(J.mulPointEscalar(gD, esk));
        // Deterministic: the sender rebuilds the same output from the same inputs.
        expect(sealOutput(J, P, { ...o, recipient })).toEqual(sealed);
    });

    it("gives outputs that differ in any bound field different randomness", () => {
        const key = buildSpendingKey(P, randomJubjubScalar());
        const recipient = addressOf(key);
        const base = { ...unaddressed(), recipient };
        const variants = [
            base,
            { ...base, outgoingKey: randomBytes(32) },
            { ...base, chainId: CHAIN + 1n },
            { ...base, rho: randomFr() },
            { ...base, asset: 2n },
            { ...base, value: 8n },
            // Another address of the same account: `d` and `pk` both move.
            { ...base, recipient: addressOf(key, 1) },
            { ...base, recipient: { ...recipient, pk: randomFr() } },
            { ...base, recipient: { ...recipient, pk_d: someAddress().pk_d } },
            { ...base, recipient: { ...recipient, ck_d: someAddress().ck_d } },
            // Another spend: one nullifier moved, the two swapped, one fewer, none.
            { ...base, nullifiers: [NULLIFIERS[0]!, NULLIFIERS[1]! + 1n] },
            { ...base, nullifiers: [NULLIFIERS[1]!, NULLIFIERS[0]!] },
            { ...base, nullifiers: [NULLIFIERS[0]!] },
            { ...base, nullifiers: [] },
        ];

        const sealed = variants.map((v) => sealOutput(J, P, v));

        const distinct = (pick: (s: (typeof sealed)[number]) => unknown) =>
            new Set(sealed.map((s) => String(pick(s)))).size;
        expect(distinct((s) => s.note.rcm)).toBe(variants.length);
        expect(distinct((s) => s.aux.aux.ephPub)).toBe(variants.length);
        expect(distinct((s) => s.aux.aux.clueR)).toBe(variants.length);
        expect(distinct((s) => s.aux.aux.ciphertext)).toBe(variants.length);
    });

    // Addresses that share `d` and `pk` commit under the same key on the same base, so only `osk`
    // separates their commitment blinder, ephemeral key and clue point.
    it.each([
        "pk_d",
        "ck_d",
    ] as const)("shares no randomness between addresses that differ only in %s", (point) => {
        const recipient = someAddress();
        const lookalike = { ...recipient, [point]: someAddress()[point] };
        const o = unaddressed();

        const a = sealOutput(J, P, { ...o, recipient });
        const b = sealOutput(J, P, { ...o, recipient: lookalike });

        expect(b.note.pk).toBe(a.note.pk);
        expect(b.note.rcm).not.toBe(a.note.rcm);
        expect(buildNoteCommitment(P, b.note)).not.toBe(buildNoteCommitment(P, a.note));
        expect(b.aux.aux.ephPub).not.toEqual(a.aux.aux.ephPub);
        expect(b.aux.aux.clueR).not.toEqual(a.aux.aux.clueR);
    });

    it("uses each recipient's own base and flag key, across more recipients than it caches", () => {
        const account = buildSpendingKey(P, randomJubjubScalar());
        const recipients: OutputRecipient[] = [
            // Addresses of one account differ in `d` and in `ck_d`.
            ...Array.from({ length: 6 }, (_, index) => addressOf(account, index)),
            ...Array.from({ length: 6 }, () => someAddress()),
        ];
        // Same `d`, another `ck_d`: both are part of what the expansion depends on.
        recipients.push({ ...recipients[0]!, ck_d: recipients[11]!.ck_d });
        const o = unaddressed();
        const direct = (r: OutputRecipient) =>
            sealOutput(J, P, { ...o, recipient: { ...r, oneTime: true } });

        // Two passes: the second meets every recipient again, the early ones after eviction.
        for (let pass = 0; pass < 2; pass++) {
            for (const r of recipients) {
                expect(sealOutput(J, P, { ...o, recipient: r })).toEqual(direct(r));
            }
        }
    });

    it("rejects an output it cannot bind", () => {
        const recipient = someAddress();
        const o = { ...unaddressed(), recipient };

        const bad = [
            { ...o, outgoingKey: randomBytes(31) },
            { ...o, rho: BN254_FR },
            { ...o, value: 1n << 64n },
            { ...o, asset: -1n },
            { ...o, recipient: { ...recipient, d: 1n << 128n } },
            { ...o, recipient: { ...recipient, pk: BN254_FR } },
            { ...o, nullifiers: [1n, BN254_FR] },
        ];
        for (const args of bad) {
            expect(() => sealOutput(J, P, args)).toThrow(InvalidArgumentError);
        }
    });
});

describe("buildSpend outputs", () => {
    function fixture() {
        const me = buildSpendingKey(P, randomJubjubScalar());
        const payee = buildSpendingKey(P, randomJubjubScalar());
        const mine = addressOf(me);
        // The input sits at a non-default address of the sender.
        const inputAddr = addressOf(me, 9);
        const input = inputSlot(note(100n, inputAddr.pk), { nsk: me.nsk, d: inputAddr.d });
        const prover = recordingProver();
        const outgoingKey = deriveOutgoingKey(me.nsk);
        const spend = (
            outputs: OutputSpec[],
            inputs: (InputSlot | null)[] = [input, null],
        ): Promise<BuiltBundle> => buildSpend(spendArgs({ prover, inputs, outputs, outgoingKey }));
        return { me, payee, mine, inputAddr, input, prover, spend };
    }

    it("delivers to a payee at a non-default address, and its pads to no one", async () => {
        const { me, payee, mine, spend } = fixture();
        const payeeAddr = addressOf(payee, 5);

        const built = await spend(
            [padAddress(J), payeeAddr, padAddress(J), mine, padAddress(J)].map((r, i) =>
                out(i === 1 ? 30n : i === 3 ? 70n : 0n, r),
            ),
        );
        const inputs = scanInputsOf(J, built.payload.aux, built.cm);

        const payeeStats = emptyScanStats();
        const payeeHits = scanNotes(J, P, payee.ivk, inputs, payeeStats);
        expect(payeeHits).toHaveLength(1);
        expect(payeeHits[0]).toMatchObject({ asset: 1n, value: 30n, d: payeeAddr.d, leafIndex: 1 });
        expect(payeeHits[0]!.cm).toBe(built.cm[1]);
        // What the payee stores opens the published commitment under its own key for that address.
        expect(
            buildNoteCommitment(P, {
                ...payeeHits[0]!,
                pk: deriveDiversifiedPk(P, payee.ivk, payeeHits[0]!.d),
            }),
        ).toBe(built.cm[1]);
        expect(payeeStats).toEqual({ ...emptyScanStats(), scanned: 5, notOurs: 4, hits: 1 });

        const myStats = emptyScanStats();
        const myHits = scanNotes(J, P, me.ivk, inputs, myStats);
        expect(myHits.map((h) => [h.value, h.d, h.leafIndex])).toEqual([[70n, mine.d, 3]]);
        // The pads open for neither party: they are `notOurs`, not zero-value notes of the sender.
        expect(myStats).toEqual({ ...emptyScanStats(), scanned: 5, notOurs: 4, hits: 1 });
    });

    it("gives slot i the rho of the first nullifier and i", async () => {
        const { mine, prover, spend } = fixture();
        const built = await spend([out(60n, mine), out(40n, mine), out(0n, padAddress(J))]);

        const nf0 = BigInt((prover.last!.nullifier as string[])[0]!);
        expect(built.producedNotes.map((n) => n.rho)).toEqual(
            [0, 1, 2].map((i) => buildRho(P, nf0, i)),
        );
        // Two change notes of equal owner still differ in every published value.
        expect(new Set(built.cm).size).toBe(3);
        expect(new Set(built.payload.aux.map((a) => String(a.ephPub))).size).toBe(3);
    });

    it("seals every output under the spend's public nullifiers, dummy slots included", async () => {
        const { me, mine, prover, spend } = fixture();
        const specs = [out(60n, mine), out(40n, mine), out(0n, padAddress(J))];

        const built = await spend(specs);

        const nullifiers = (prover.last!.nullifier as string[]).map(BigInt);
        expect(nullifiers).toEqual(built.payload.pubInputs.nullifier);
        expect(nullifiers).toHaveLength(2);
        for (const [index, spec] of specs.entries()) {
            const expected = sealOutput(J, P, {
                outgoingKey: deriveOutgoingKey(me.nsk),
                chainId: 31337n,
                rho: buildRho(P, nullifiers[0]!, index),
                ...spec,
                nullifiers,
            });
            expect(built.producedNotes[index]).toEqual(expected.note);
            expect(built.payload.aux[index]).toEqual(expected.aux.aux);
        }
    });

    // A paying output that repeated between two attempts, next to pads that never do, would
    // tell whoever holds both attempts which slots pay.
    it("shares no output with an earlier build of the same spend", async () => {
        const { mine, payee, prover, spend } = fixture();
        // One list for both builds: each slot keeps its value and recipient, the pad's included.
        const specs = [
            out(0n, padAddress(J)),
            out(30n, addressOf(payee, 5)),
            out(70n, mine),
            out(0n, padAddress(J)),
        ];

        const first = await spend(specs);
        const firstNullifiers = prover.last!.nullifier as string[];
        const second = await spend(specs);
        const secondNullifiers = prover.last!.nullifier as string[];

        // The real input's nullifier repeats, so every `rho` does; only the dummy slot's moved.
        expect(secondNullifiers[0]).toBe(firstNullifiers[0]);
        expect(secondNullifiers[1]).not.toBe(firstNullifiers[1]);
        expect(second.producedNotes.map((n) => n.rho)).toEqual(
            first.producedNotes.map((n) => n.rho),
        );
        for (const index of specs.keys()) {
            const [a, b] = [first.payload.aux[index]!, second.payload.aux[index]!];
            expect(second.cm[index]).not.toBe(first.cm[index]);
            expect(b.ephPub).not.toEqual(a.ephPub);
            expect(b.clueR).not.toEqual(a.clueR);
            expect(b.ciphertext).not.toEqual(a.ciphertext);
            // Past the two clue-bit bytes too: the encrypted plaintext itself moved.
            expect(b.ciphertext.subarray(2)).not.toEqual(a.ciphertext.subarray(2));
        }
    });

    // No dummy slot, so no nullifier is drawn: the slot order is all that tells two builds apart.
    it("seals a spend with no dummy slot anew when its inputs change slots, and only then", async () => {
        const { mine, inputAddr, input, spend } = fixture();
        const another = (leafIndex: number): InputSlot => ({
            ...input,
            cached: { ...input.cached, note: note(10n, inputAddr.pk), leafIndex },
        });
        const [b, c] = [another(1), another(2)];
        const specs = [out(120n, mine), out(0n, padAddress(J))];

        const first = await spend(specs, [input, b, c]);
        const reordered = await spend(specs, [input, c, b]);
        const repeated = await spend(specs, [input, b, c]);

        // Slot 0 kept its note, so every `rho` did too.
        expect(reordered.producedNotes.map((n) => n.rho)).toEqual(
            first.producedNotes.map((n) => n.rho),
        );
        for (const index of specs.keys()) {
            expect(reordered.cm[index]).not.toBe(first.cm[index]);
            expect(reordered.payload.aux[index]!.ephPub).not.toEqual(
                first.payload.aux[index]!.ephPub,
            );
        }
        expect(repeated.cm).toEqual(first.cm);
        expect(repeated.payload.aux).toEqual(first.payload.aux);
    });

    it("witnesses each input under its own diversifier", async () => {
        const { mine, inputAddr, prover, spend } = fixture();
        expect(inputAddr.d).not.toBe(mine.d);

        await spend([out(100n, mine), out(0n, padAddress(J))]);

        expect((prover.last!.in_d as string[]).map(BigInt)).toEqual([inputAddr.d, 0n]);
    });
});
