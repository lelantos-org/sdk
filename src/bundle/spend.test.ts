import { describe, expect, it } from "vitest";
import { randomFr, randomJubjubScalar } from "../core/random.js";
import type { Jubjub } from "../crypto/jubjub.js";
import { WasmJubjub } from "../crypto/jubjub-wasm/index.js";
import { Poseidon } from "../crypto/poseidon.js";
import { fmdClueKeyFromRoot } from "../fmd/fmd.js";
import type { Note } from "../notes/note.js";
import type { SpendKind } from "../protocol/transact.js";
import type { Prover } from "../prover/types.js";
import type { InputSlot } from "./common.js";
import { buildSpend, type SpendArgs } from "./spend.js";

// `kind` routes the on-chain call: a transfer tagged `withdrawNative` would
// reach NativeAdapter.withdrawNative and unwrap WETH to a recipient. It is a plain
// argument to the shared builder, so each kind is asserted here.

/** Records the witness instead of proving; proving is minutes and ~29 MB. */
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

function note(_J: Jubjub, value: bigint, pk: bigint): Note {
    return {
        asset: 1n,
        value,
        pk,
        rho: randomFr(),
        rcm: randomFr(),
        rcv: randomJubjubScalar(),
        rcvDep: randomJubjubScalar(),
    };
}

describe("buildSpend", () => {
    it("tags the payload with the kind it was given", async () => {
        const P = await Poseidon.build();
        const J = await WasmJubjub.build();
        const pk = randomFr();
        const pkD = J.mulPointEscalar(J.base8, randomJubjubScalar());
        const recipient = { pk_d: pkD, pk, ck: fmdClueKeyFromRoot(J, randomFr()) };

        const treeDepth = 4;
        const input: InputSlot = {
            cached: {
                note: note(J, 100n, pk),
                nsk: randomJubjubScalar(),
                leafIndex: 0,
            },
            pathElements: Array.from({ length: treeDepth }, () => [0n, 0n, 0n]),
            pathIndices: Array.from({ length: treeDepth }, () => 0),
        };

        const base = (kind: SpendKind, publicOut: bigint, outs: [Note, Note]): SpendArgs => ({
            P,
            J,
            kind,
            chainId: 31337n,
            asset: 1n,
            payerAddress: "0x0000000000000000000000000000000000000000",
            relayerAddress: "0x0000000000000000000000000000000000000000",
            recipientAddress: "0x0000000000000000000000000000000000000000",
            prover: recordingProver(),
            treeDepth,
            inputs: [input, null],
            merkleRoot: 0n,
            outputs: outs,
            outputRecipients: [recipient, recipient],
            outputRandomness: [
                { esk: randomJubjubScalar(), fmdR: randomJubjubScalar() },
                { esk: randomJubjubScalar(), fmdR: randomJubjubScalar() },
            ],
            publicOut,
        });

        for (const kind of ["transfer", "withdraw", "withdrawNative"] as SpendKind[]) {
            const publicOut = kind === "transfer" ? 0n : 40n;
            const outs: [Note, Note] = [note(J, 100n - publicOut, pk), note(J, 0n, pk)];
            const built = await buildSpend(base(kind, publicOut, outs));

            expect(built.payload.kind).toBe(kind);
            expect(built.payload.pubInputs.publicOut).toBe(publicOut);
            expect(built.payload.pubInputs.publicIn).toBe(0n);
            expect(built.cm).toHaveLength(2);
            expect(built.payload.aux).toHaveLength(2);
        }
    });

    it("rejects an unbalanced spend, naming the kind", async () => {
        const P = await Poseidon.build();
        const J = await WasmJubjub.build();
        const pk = randomFr();
        const pkD = J.mulPointEscalar(J.base8, randomJubjubScalar());
        const recipient = { pk_d: pkD, pk, ck: fmdClueKeyFromRoot(J, randomFr()) };

        const args: SpendArgs = {
            P,
            J,
            kind: "withdraw",
            chainId: 31337n,
            asset: 1n,
            payerAddress: "0x0000000000000000000000000000000000000000",
            relayerAddress: "0x0000000000000000000000000000000000000000",
            recipientAddress: "0x0000000000000000000000000000000000000000",
            prover: recordingProver(),
            treeDepth: 4,
            inputs: [
                {
                    cached: { note: note(J, 100n, pk), nsk: randomJubjubScalar(), leafIndex: 0 },
                    pathElements: Array.from({ length: 4 }, () => [0n, 0n, 0n]),
                    pathIndices: [0, 0, 0, 0],
                },
                null,
            ],
            merkleRoot: 0n,
            outputs: [note(J, 90n, pk), note(J, 0n, pk)],
            outputRecipients: [recipient, recipient],
            outputRandomness: [
                { esk: randomJubjubScalar(), fmdR: randomJubjubScalar() },
                { esk: randomJubjubScalar(), fmdR: randomJubjubScalar() },
            ],
            publicOut: 40n, // 90 + 40 != 100
        };

        await expect(buildSpend(args)).rejects.toThrow(/withdraw balance/);
    });

    it("requires at least one real input", async () => {
        const P = await Poseidon.build();
        const J = await WasmJubjub.build();
        const pk = randomFr();
        const pkD = J.mulPointEscalar(J.base8, randomJubjubScalar());
        const recipient = { pk_d: pkD, pk, ck: fmdClueKeyFromRoot(J, randomFr()) };

        await expect(
            buildSpend({
                P,
                J,
                kind: "transfer",
                chainId: 31337n,
                asset: 1n,
                payerAddress: "0x0000000000000000000000000000000000000000",
                relayerAddress: "0x0000000000000000000000000000000000000000",
                recipientAddress: "0x0000000000000000000000000000000000000000",
                prover: recordingProver(),
                treeDepth: 4,
                inputs: [null, null],
                merkleRoot: 0n,
                outputs: [note(J, 0n, pk), note(J, 0n, pk)],
                outputRecipients: [recipient, recipient],
                outputRandomness: [
                    { esk: randomJubjubScalar(), fmdR: randomJubjubScalar() },
                    { esk: randomJubjubScalar(), fmdR: randomJubjubScalar() },
                ],
            }),
        ).rejects.toThrow(/transfer: at least one real input/);
    });
});

describe("buildSpend pre-flight", () => {
    // Each of these builds a witness the prover accepts the shape of and then
    // fails on — five to sixty seconds later, as an opaque circom assertion,
    // or as a valid-looking proof the chain rejects. All are cheap to catch
    // before an artifact is even fetched.

    async function fixture() {
        const P = await Poseidon.build();
        const J = await WasmJubjub.build();
        const pk = randomFr();
        const pkD = J.mulPointEscalar(J.base8, randomJubjubScalar());
        const recipient = { pk_d: pkD, pk, ck: fmdClueKeyFromRoot(J, randomFr()) };
        const treeDepth = 4;

        const slot = (): InputSlot => ({
            cached: { note: note(J, 100n, pk), nsk: randomJubjubScalar(), leafIndex: 0 },
            pathElements: Array.from({ length: treeDepth }, () => [0n, 0n, 0n]),
            pathIndices: Array.from({ length: treeDepth }, () => 0),
        });

        const args = (over: Partial<SpendArgs> = {}): SpendArgs => ({
            P,
            J,
            kind: "transfer",
            chainId: 31337n,
            asset: 1n,
            payerAddress: "0x0000000000000000000000000000000000000000",
            relayerAddress: "0x0000000000000000000000000000000000000000",
            recipientAddress: "0x0000000000000000000000000000000000000000",
            prover: recordingProver(),
            treeDepth,
            inputs: [slot(), null],
            merkleRoot: 0n,
            outputs: [note(J, 100n, pk), note(J, 0n, pk)],
            outputRecipients: [recipient, recipient],
            outputRandomness: [
                { esk: randomJubjubScalar(), fmdR: randomJubjubScalar() },
                { esk: randomJubjubScalar(), fmdR: randomJubjubScalar() },
            ],
            ...over,
        });

        return { J, pk, slot, args };
    }

    it("accepts a well-formed spend", async () => {
        const { args } = await fixture();
        await expect(buildSpend(args())).resolves.toBeDefined();
    });

    // Mixing assets is legal — see the "buildSpend, multi-asset" block below.
    // What is not legal is an asset that fails to conserve, and these two are
    // the shapes a mis-built selection actually takes: an input nothing spends,
    // and an output nothing funds.

    it("rejects an input whose asset no output accounts for", async () => {
        const { J, pk, slot, args } = await fixture();
        const foreign = slot();
        foreign.cached.note = { ...note(J, 100n, pk), asset: 7n };

        // Asset 7 enters and never leaves; asset 1 leaves without entering.
        await expect(buildSpend(args({ inputs: [foreign, null] }))).rejects.toThrow(
            /balance for asset 7: in=100 out=0/,
        );
    });

    it("rejects an output minting an asset no input supplied", async () => {
        const { J, pk, args } = await fixture();
        const outs = [{ ...note(J, 100n, pk), asset: 9n }, note(J, 0n, pk)];

        await expect(buildSpend(args({ outputs: outs }))).rejects.toThrow(
            /balance for asset 1: in=100 out=0/,
        );
    });

    it("rejects slot counts that do not match the named shape", async () => {
        const { args } = await fixture();
        // Two outputs against a 3x3 key builds a 34-coefficient witness and a
        // completely different Fiat-Shamir `z`.
        await expect(buildSpend(args({ shape: { nIn: 3, nOut: 3 } }))).rejects.toThrow(
            /input slots for a 3x3 circuit/,
        );
    });

    it("accepts slot counts that do match the named shape", async () => {
        const { args } = await fixture();
        await expect(buildSpend(args({ shape: { nIn: 2, nOut: 2 } }))).resolves.toBeDefined();
    });

    it("rejects a binary-shaped path from a mis-implemented relayer", async () => {
        // One sibling per level and indices 0/1: builds a witness fine and
        // proves against a root that is not the tree's.
        const { slot, args } = await fixture();
        const binary = slot();
        binary.pathElements = Array.from({ length: 4 }, () => [0n]);

        await expect(buildSpend(args({ inputs: [binary, null] }))).rejects.toThrow(
            /1 siblings, expected 3/,
        );
    });

    it("rejects a path whose depth is not the tree's", async () => {
        const { slot, args } = await fixture();
        const short = slot();
        short.pathElements = Array.from({ length: 2 }, () => [0n, 0n, 0n]);
        short.pathIndices = [0, 0];

        await expect(buildSpend(args({ inputs: [short, null] }))).rejects.toThrow(
            /2-level path .* depth-4 tree/,
        );
    });

    it("rejects an out-of-range path index", async () => {
        const { slot, args } = await fixture();
        const bad = slot();
        bad.pathIndices = [0, 4, 0, 0];

        await expect(buildSpend(args({ inputs: [bad, null] }))).rejects.toThrow(
            /level 1 has index 4/,
        );
    });

    it("rejects a value wider than the circuit's 64-bit range check", async () => {
        const { J, pk, slot, args } = await fixture();
        const huge = slot();
        huge.cached.note = note(J, 1n << 64n, pk);

        await expect(
            buildSpend(
                args({ inputs: [huge, null], outputs: [note(J, 1n << 64n, pk), note(J, 0n, pk)] }),
            ),
        ).rejects.toThrow(/64-bit unsigned integer/);
    });
});

// Cross-asset fees: the circuit conserves value per asset (PerAssetValueBalance
// in circuits/src/lib/balance.circom), so one proof may carry the asset being
// moved alongside a second asset that pays the relayer. These pin that the SDK
// agrees with the circuit rather than being stricter than it.
describe("buildSpend, multi-asset", () => {
    const ZERO = "0x0000000000000000000000000000000000000000";

    async function fixture() {
        const P = await Poseidon.build();
        const J = await WasmJubjub.build();
        const pk = randomFr();
        const pkD = J.mulPointEscalar(J.base8, randomJubjubScalar());
        const recipient = { pk_d: pkD, pk, ck: fmdClueKeyFromRoot(J, randomFr()) };
        const treeDepth = 4;

        const slot = (asset: bigint, value: bigint, leafIndex: number): InputSlot => ({
            cached: {
                note: { ...note(J, value, pk), asset },
                nsk: randomJubjubScalar(),
                leafIndex,
            },
            pathElements: Array.from({ length: treeDepth }, () => [0n, 0n, 0n]),
            pathIndices: Array.from({ length: treeDepth }, () => 0),
        });

        const out = (asset: bigint, value: bigint): Note => ({ ...note(J, value, pk), asset });

        const args = (inputs: SpendArgs["inputs"], outputs: Note[], publicOut = 0n): SpendArgs => ({
            P,
            J,
            kind: "transfer",
            chainId: 31337n,
            asset: 1n,
            payerAddress: ZERO,
            relayerAddress: ZERO,
            recipientAddress: ZERO,
            prover: recordingProver(),
            treeDepth,
            inputs,
            merkleRoot: 0n,
            outputs,
            outputRecipients: outputs.map(() => recipient),
            outputRandomness: outputs.map(() => ({
                esk: randomJubjubScalar(),
                fmdR: randomJubjubScalar(),
            })),
            publicOut,
        });

        return { slot, out, args };
    }

    /// The feature this exists for: move asset 1, pay the relayer in asset 2.
    it("accepts a spend whose fee is paid in a second asset", async () => {
        const { slot, out, args } = await fixture();
        const built = await buildSpend(
            args(
                [slot(1n, 100n, 0), slot(2n, 30n, 1)],
                // send 1, change 1, fee 2, change 2
                [out(1n, 70n), out(1n, 30n), out(2n, 25n), out(2n, 5n)],
            ),
        );
        expect(built.cm).toHaveLength(4);
    });

    /// Per-asset, not in aggregate. Asset 1 burns 5 and asset 2 mints 5, so the
    /// totals match exactly — this is the cross-asset forgery
    /// `PerAssetValueBalance` exists to reject, and the single global sum this
    /// check replaced would have waved it through to the prover.
    it("rejects an imbalance that a global sum would miss", async () => {
        const { slot, out, args } = await fixture();
        const inputs = [slot(1n, 100n, 0), slot(2n, 30n, 1)];
        const outputs = [out(1n, 65n), out(1n, 30n), out(2n, 30n), out(2n, 5n)];

        // The premise: a global sum cannot tell these apart.
        const sumIn = inputs.reduce((t, s) => t + s.cached.note.value, 0n);
        const sumOut = outputs.reduce((t, o) => t + o.value, 0n);
        expect(sumIn).toBe(sumOut);

        await expect(buildSpend(args(inputs, outputs))).rejects.toThrow(/balance for asset/);
    });

    /// `publicOut` leaves the pool in the transparent bucket, which the circuit
    /// hard-wires to a single `public_asset_id`. It must count against that
    /// asset only — charged to the fee asset instead, a withdraw would appear
    /// to balance while stealing from the fee.
    it("attributes publicOut to the transparent bucket's asset alone", async () => {
        const { slot, out, args } = await fixture();
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
