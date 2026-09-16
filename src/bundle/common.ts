// Shared bundle types and builder helpers for deposit, transfer and withdraw.
//
// `buildSpend` proves the transact SNARK for transfer, withdraw and
// withdrawNative, and returns a `SubmitTransactPayload` for `/v1/spend`.
// `buildDeposit` does not prove; deposits go through `MASP.deposit` (Permit2
// witness) and it returns a `BuiltDeposit` the wallet signs and broadcasts. The
// relayer serves no deposit route: it picks the escrow up from the
// `DepositEscrowed` event.

import {
    circuitSignals,
    dummyInputAt,
    fiatShamirZ,
    flatten,
    type SpendableCachedNote,
    type TransactWitnessBundle,
    toCircomInput,
    toSpentNoteFromPath,
} from "../circuit/index.js";
import { assertField } from "../core/field.js";
import { randomFr } from "../core/random.js";
import { buildRho, type Field, type Jubjub, type Point, type Poseidon } from "../crypto/index.js";
import { InternalError } from "../errors/base.js";
import { WalletConfigError } from "../errors/config.js";
import { FMD_DEFAULT_GAMMA, fmdExpandFlagKey } from "../fmd/keys.js";
import { buildOutputAux, type OutputAux, type OutputAuxWithWitness } from "../notes/aux.js";
import type { Note } from "../notes/note.js";
import { auxDigest } from "../protocol/abi-hash.js";
import { auxOutputToWire } from "../protocol/aux-wire.js";
import type { CircuitShape } from "../protocol/shape.js";
import type { SpendKind, SubmitTransactPayload, TransactPubInputs } from "../protocol/transact.js";
import type { Groth16Proof, Prover, ProverArtifacts } from "../prover/types.js";

export interface OutputRecipient {
    pk_d: Point;
    /**
     * Note-commitment binding scalar; same value the receiver derives via
     * `derivePkFromIvk`. Part of the bech32m address.
     */
    pk: Field;
    /**
     * FMD clue key from the recipient's address: the public half. Expanding it
     * yields flag-key points, never detection scalars.
     */
    ck: Point;
}

/**
 * Per-output rng material. Caller owns randomness; SDK is pure.
 *
 * @internal
 */
export interface OutputRandomness {
    esk: Field;
    fmdR: Field;
}

/** @internal */
export interface BundleCommon {
    P: Poseidon;
    J: Jubjub;
    chainId: bigint;
    asset: bigint;
    payerAddress: string; // 0x ETH (deposit ERC20 source; pass `0x0` for transfer/withdraw)
    /**
     * 0x ETH. The address the relayer publishes as its submitter (`/chains`
     * `relayerAddress`), which is the pool's `msg.sender` for its spends and so
     * must equal `pi.relayer`. For a relayer submitting through its `Bundler`
     * contract this is the Bundler's address, not the EOA signing the outer
     * transaction.
     */
    relayerAddress: string;
    recipientAddress: string; // 0x ETH (on-chain recipient for withdraw, sender for deposit/transfer)
    /**
     * `PubInputs.Transact.intentHash`, a field element. A swap's withdraw leg
     * must set it to `swapIntentHash` of the swap it funds; every other spend
     * leaves it at the zero default.
     */
    intentHash?: bigint;
    /**
     * Pluggable prover. Pass either:
     *   - `artifacts: ProverArtifacts` — the SDK proves with snarkjs
     *   - `prover: Prover` — a custom backend (remote / worker / mock)
     * Exactly one is required.
     */
    artifacts?: ProverArtifacts;
    prover?: Prover;
    treeDepth: number;
    /**
     * Circuit arity, when the caller knows it.
     *
     * Optional because `toCircomInput` infers the shape from the array lengths.
     * Supplying it enables a pre-flight check that the slot counts match the
     * zkey; without it a spend with the wrong output count for the key builds a valid
     * witness with the wrong number of public inputs and fails inside the prover.
     */
    shape?: CircuitShape;
}

/** @internal */
export interface BuiltBundle {
    payload: SubmitTransactPayload;
    /** One commitment per output slot: `nOut` entries. */
    cm: Field[];
    /** The output notes, in slot order: `nOut` entries. */
    producedNotes: Note[];
}

/**
 * One real input slot for transfer/withdraw. Pass `null` in the
 * per-slot tuple to fill that slot with a dummy.
 */
export interface InputSlot {
    cached: SpendableCachedNote;
    pathElements: Field[][];
    pathIndices: number[];
}

/**
 * Real-or-dummy input mask, one entry per input slot: an `InputSlot` for a
 * real spend or `null` for a dummy. Length must equal the shape's `nIn`, and
 * at least one entry must be non-null. The balance equation is enforced
 * inside the builder.
 *
 * @internal
 */
export type InputSlots = readonly (InputSlot | null)[];

type SpentNoteInput = ReturnType<typeof toSpentNoteFromPath>;

/**
 * Fill every input slot, substituting a dummy for `null`. Every dummy gets a
 * fresh `rho` and fresh blinders: both reach the public inputs, `rho` through
 * the nullifier and `rcv` through `in_cv`.
 *
 * @internal
 */
export function buildInputs(P: Poseidon, slots: InputSlots, treeDepth: number): SpentNoteInput[] {
    return slots.map((s) =>
        s
            ? toSpentNoteFromPath(P, s.cached, s.pathElements, s.pathIndices)
            : dummyInputAt(P, treeDepth, randomFr()),
    );
}

/**
 * Bind each output-note rho to the Orchard-style derivation the transact
 * circuit enforces: rho = Poseidon(TAG_RHO, nullifier[0], out_index). Overrides
 * any caller-supplied rho so no two committed output notes can share a rho
 * (→ a future nullifier). MUST run before aux/cm are built from the notes.
 *
 * @internal
 */
export function deriveOutputRho(P: Poseidon, nf0: Field, outputs: readonly Note[]): Note[] {
    return outputs.map((note, index) => ({ ...note, rho: buildRho(P, nf0, index) }));
}

/** @internal */
export function buildAuxForReal(
    J: Jubjub,
    P: Poseidon,
    note: Note,
    recipient: OutputRecipient,
    rng: OutputRandomness,
    gamma: number = FMD_DEFAULT_GAMMA,
): OutputAuxWithWitness {
    return buildOutputAux({
        J,
        P,
        recipientFlagKey: fmdExpandFlagKey(J, P, recipient.ck, gamma),
        recipientPkD: recipient.pk_d,
        note,
        esk: rng.esk,
        fmdR: rng.fmdR,
    });
}

/** @internal */
export async function finalize(
    common: BundleCommon,
    kind: SpendKind,
    inputs: readonly SpentNoteInput[],
    outputs: readonly Note[],
    merkleRoot: Field,
    publicIn: bigint,
    publicOut: bigint,
    auxAndWitness: readonly OutputAuxWithWitness[],
): Promise<BuiltBundle> {
    // Resolved before the witness is built, so a missing backend fails fast.
    const prove = proverFor(common);
    const intentHash = common.intentHash ?? 0n;
    // The contract compares the full uint256 word; an unreduced value would
    // make the proof bind a different word than the wrapper recomputes.
    assertField(intentHash, "intentHash");
    const aux: OutputAux[] = auxAndWitness.map((a) => a.aux);

    const { J, asset } = common;

    const baseInput = toCircomInput(common.P, J, {
        publicAssetId: asset,
        publicIn,
        publicOut,
        inputs: [...inputs],
        outputs: [...outputs],
        outputClues: auxAndWitness.map((a) => a.witness),
        outputAuxDigest: auxDigest(aux.map(auxOutputToWire)),
        merkleRoot,
        recipientAddress: BigInt(common.recipientAddress),
        chainId: common.chainId,
        payerAddress: BigInt(common.payerAddress),
        relayerAddress: BigInt(common.relayerAddress),
        intentHash,
        z: 0n,
    });

    const z = fiatShamirZ(flatten(baseInput));
    // `circuitSignals` drops the challenge-only fields. They are logical public
    // inputs (hashed into `z` above) but not circuit signals, and the
    // witness calculator rejects a key the circuit does not declare.
    const proof = await prove({ ...circuitSignals({ ...baseInput, z: z.toString() }) });

    return {
        payload: {
            chainId: common.chainId,
            kind,
            proof: groth16ToWire(proof),
            pubInputs: extractPubInputs(common, baseInput, publicIn, publicOut),
            aux: [...aux],
        },
        // Read back from the witness, where `toCircomInput` already hashed each
        // output commitment, so the value the proof commits to has one source.
        cm: baseInput.out_cm.map((c) => BigInt(c)),
        producedNotes: [...outputs],
    };
}

/**
 * The configured proving backend, as a function from circuit input to proof.
 *
 * The single check that one of `prover` or `artifacts` is set.
 */
function proverFor(
    common: BundleCommon,
): (input: Record<string, unknown>) => Promise<Groth16Proof> {
    const { prover, artifacts } = common;
    if (prover) return async (input) => (await prover.prove(input)).proof;
    if (!artifacts) {
        throw new WalletConfigError("BundleCommon: either `prover` or `artifacts` is required");
    }
    return async (input) => {
        // Loaded lazily. Only `prover/snarkjs.ts` may reach the optional `snarkjs` peer,
        // and only lazily; an eager import on the default path makes the optional
        // dependency mandatory. This module is on the default path (`buildSpend` →
        // `finalize` → here), so a static import would make every `./protocol`
        // consumer carry the backend.
        const { SnarkjsProver } = await import("../prover/snarkjs.js");
        return (await new SnarkjsProver(artifacts).prove(input)).proof;
    };
}

/**
 * Lift the public-input subset of the (decimal-string) circom witness back
 * into native bigints for the relayer wire format.
 *
 * @internal
 */
function extractPubInputs(
    common: BundleCommon,
    base: TransactWitnessBundle,
    publicIn: bigint,
    publicOut: bigint,
): TransactPubInputs {
    // The explicit re-parse is the trust boundary between the prover witness
    // (decimal strings) and the relayer wire format (bigints/points). Typing
    // the witness as `TransactWitnessBundle` keeps it cast-free.
    // A curve point is always (x, y) whatever the shape — unlike the
    // per-slot arrays below, whose length is `nIn` or `nOut`.
    const point = (v: readonly string[] | undefined): [bigint, bigint] => {
        if (v?.length !== 2) {
            throw new InternalError(
                `extractPubInputs: a curve point needs 2 coordinates, got ${v?.length}`,
            );
        }
        return [BigInt(v[0] as string), BigInt(v[1] as string)];
    };
    const scalars = (v: readonly string[]): bigint[] => v.map((x) => BigInt(x));

    return {
        merkleRoot: BigInt(base.merkle_root),
        nullifier: scalars(base.nullifier),
        outCm: scalars(base.out_cm),
        publicAssetId: common.asset,
        publicIn,
        publicOut,
        inCv: base.in_cv.map(point),
        outCv: base.out_cv.map(point),
        recipient: common.recipientAddress,
        chainId: common.chainId,
        payer: common.payerAddress,
        relayer: common.relayerAddress,
        intentHash: BigInt(base.intent_hash),
        outCvDep: base.out_cv_dep.map(point),
    };
}

/** @internal */
const groth16ToWire = (p: Groth16Proof): SubmitTransactPayload["proof"] => ({
    piA: p.pi_a,
    piB: p.pi_b,
    piC: p.pi_c,
    protocol: p.protocol,
    curve: p.curve,
});
