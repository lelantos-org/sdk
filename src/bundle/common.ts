// Shared bundle types + builder helpers used by deposit/transfer/withdraw.
//
// The transact spend builders (`buildTransfer`, `buildWithdraw`, `buildWithdrawNative`)
// prove the transact_2x2 SNARK and return a `SubmitTransactPayload` for
// `/v1/transact`. `buildDeposit` does NOT prove — deposits go through
// `MASP.submitIntent` (Permit2 witness); returns a `BuiltIntent` for the
// wallet to sign + POST to `/v1/intent`.

import type { CircomTransactInput } from "../circuit/index.js";
import {
    dummyInputAt,
    fiatShamirZ,
    flatten,
    type SpendableCachedNote,
    toCircomInput,
    toSpentNoteFromPath,
} from "../circuit/index.js";
import { WalletConfigError } from "../core/errors.js";
import { randomFr } from "../core/random.js";
import {
    buildNoteCommitment,
    buildRho,
    type Field,
    type Jubjub,
    type Point,
    type Poseidon,
} from "../crypto/index.js";
import {
    buildOutputAux,
    flagKeyFromAddressDk,
    type OutputAux,
    type OutputAuxWithWitness,
} from "../notes/aux.js";
import type { Note } from "../notes/note.js";
import { auxDigest } from "../protocol/abi-hash.js";
import { auxOutputToWire } from "../protocol/aux-wire.js";
import type { SpendKind, SubmitTransactPayload, TransactPubInputs } from "../protocol/transact.js";
import { prove } from "../prover/snarkjs.js";
import type { Groth16Proof, Prover, ProverPaths } from "../prover/types.js";

export interface OutputRecipient {
    pk_d: Point;
    dk: Field;
    /**
     * Note-commitment binding scalar; same value the receiver derives via
     * `derivePkFromIvk`. Part of the bech32m address.
     */
    pk: Field;
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
    relayerAddress: string; // 0x ETH; must equal relayer's signing key
    recipientAddress: string; // 0x ETH (on-chain recipient for withdraw, sender for deposit/transfer)
    /**
     * Pluggable prover. Pass either:
     *   - `proverPaths: ProverPaths` — the SDK builds a `SnarkjsProver`
     *   - `prover: Prover` — a custom backend (remote / worker / mock)
     * Exactly one is required.
     */
    proverPaths?: ProverPaths;
    prover?: Prover;
    treeDepth: number;
}

/** @internal */
export interface BuiltBundle {
    payload: SubmitTransactPayload;
    cm: [Field, Field];
    producedNotes: [Note, Note];
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
 * Two-slot real-or-dummy input mask. `[a, b]` where each entry is either
 * an `InputSlot` (real spend) or `null` (dummy). At least one must be
 * non-null; balance equation enforced inside the builder.
 *
 * @internal
 */
export type InputSlots = [InputSlot | null, InputSlot | null];

/**
 * Fill both input slots, substituting a dummy for `null`. Every dummy gets a
 * fresh `rho` and fresh blinders: both reach the public inputs, `rho` through
 * the nullifier and `rcv` through `in_cv`.
 *
 * @internal
 */
export function buildInputs(
    P: Poseidon,
    slots: InputSlots,
    treeDepth: number,
): ReturnType<typeof toSpentNoteFromPath>[] {
    return slots.map((s) =>
        s
            ? toSpentNoteFromPath(P, s.cached, s.pathElements, s.pathIndices)
            : dummyInputAt(P, treeDepth, randomFr()),
    );
}

/**
 * Bind each output-note rho to the Orchard-style derivation the transact_2x2
 * circuit enforces: rho = Poseidon(TAG_RHO, nullifier[0], out_index). Overrides
 * any caller-supplied rho so no two committed output notes can share a rho
 * (→ a future nullifier). MUST run before aux/cm are built from the notes.
 *
 * @internal
 */
export function deriveOutputRho(P: Poseidon, nf0: Field, outputs: [Note, Note]): [Note, Note] {
    return [
        { ...outputs[0], rho: buildRho(P, nf0, 0) },
        { ...outputs[1], rho: buildRho(P, nf0, 1) },
    ];
}

/** @internal */
export function buildAuxForReal(
    J: Jubjub,
    P: Poseidon,
    note: Note,
    recipient: OutputRecipient,
    rng: OutputRandomness,
): OutputAuxWithWitness {
    const { flag } = flagKeyFromAddressDk(J, recipient.dk);
    return buildOutputAux({
        J,
        P,
        recipientFlagKey: flag,
        recipientPkD: recipient.pk_d,
        note: {
            asset: note.asset,
            value: note.value,
            rho: note.rho,
            rcm: note.rcm,
            rcvDep: note.rcvDep,
        },
        esk: rng.esk,
        fmdR: rng.fmdR,
    });
}

/** @internal */
export async function finalize(
    common: BundleCommon,
    kind: SpendKind,
    inputs: ReturnType<typeof dummyInputAt>[],
    outputs: Note[],
    merkleRoot: Field,
    publicIn: bigint,
    publicOut: bigint,
    auxAndWitness: [OutputAuxWithWitness, OutputAuxWithWitness],
): Promise<BuiltBundle> {
    if (!common.prover && !common.proverPaths) {
        throw new Error("BundleCommon: either `prover` or `proverPaths` is required");
    }
    const aux: [OutputAux, OutputAux] = [auxAndWitness[0].aux, auxAndWitness[1].aux];

    const { J, asset } = common;

    const baseInput = toCircomInput(common.P, J, {
        publicAssetId: asset,
        publicIn,
        publicOut,
        inputs,
        outputs,
        outputClues: auxAndWitness.map((a) => a.witness),
        outputAuxDigest: auxDigest(aux.map(auxOutputToWire)),
        merkleRoot,
        recipientAddress: addrToField(common.recipientAddress),
        chainId: common.chainId,
        payerAddress: addrToField(common.payerAddress),
        relayerAddress: addrToField(common.relayerAddress),
        z: 0n,
    });

    const z = computeFiatShamirZ(baseInput);
    const proof = await runProver(common, { ...baseInput, z: z.toString() });

    return {
        payload: {
            chainId: common.chainId,
            kind,
            proof2x2: groth16ToWire(proof),
            pubInputs: extractPubInputs(common, baseInput, asset, publicIn, publicOut),
            aux: [aux[0], aux[1]],
        },
        cm: [buildNoteCommitment(common.P, outputs[0]), buildNoteCommitment(common.P, outputs[1])],
        producedNotes: [outputs[0], outputs[1]],
    };
}

/**
 * Field element → 0x-hex 32 B (matches MASP `bytes32` slot encoding).
 *
 * @internal
 */
export function fieldToBytes32(f: Field): string {
    return `0x${f.toString(16).padStart(64, "0")}`;
}

/** @internal */
function computeFiatShamirZ(baseInput: CircomTransactInput): bigint {
    return fiatShamirZ(flatten(baseInput));
}

/** @internal */
export async function runProver(
    common: BundleCommon,
    input: Record<string, unknown>,
): Promise<Groth16Proof> {
    if (common.prover) return (await common.prover.prove(input)).proof;
    if (!common.proverPaths) {
        // `finalize` rejects this combination up front; reaching here means
        // a caller built a bundle by hand and skipped that check.
        throw new WalletConfigError("bundle: one of `prover` or `proverPaths` is required");
    }
    return (await prove(input, common.proverPaths)).proof;
}

/**
 * Lift the public-input subset of the (decimal-string) circom witness back
 * into native bigints for the relayer wire format.
 *
 * @internal
 */
function extractPubInputs(
    common: BundleCommon,
    base: CircomTransactInput,
    asset: bigint,
    publicIn: bigint,
    publicOut: bigint,
): TransactPubInputs {
    // The explicit re-parse is the trust boundary between the prover witness
    // (decimal strings) and the relayer wire format (bigints/points). Typing
    // the witness as `CircomTransactInput` keeps it cast-free.
    const pair = (v: string[]): [bigint, bigint] => [BigInt(v[0]), BigInt(v[1])];

    return {
        merkleRoot: BigInt(base.merkle_root),
        nullifier: pair(base.nullifier),
        outCm: pair(base.out_cm),
        publicAssetId: asset,
        publicIn,
        publicOut,
        inCv: [pair(base.in_cv[0]), pair(base.in_cv[1])],
        outCv: [pair(base.out_cv[0]), pair(base.out_cv[1])],
        recipient: common.recipientAddress,
        chainId: common.chainId,
        payer: common.payerAddress,
        relayer: common.relayerAddress,
        outCvDep: [pair(base.out_cv_dep[0]), pair(base.out_cv_dep[1])],
    };
}

/** @internal */
const addrToField = (hex: string): Field => BigInt(hex);

/** @internal */
const groth16ToWire = (p: Groth16Proof): SubmitTransactPayload["proof2x2"] => ({
    piA: p.pi_a,
    piB: p.pi_b,
    piC: p.pi_c,
    protocol: p.protocol,
    curve: p.curve,
});
