// Shared bundle types + builder helpers used by deposit/transfer/withdraw.
//
// The transact spend builders (`buildTransfer`, `buildWithdraw`, `buildWithdrawNative`)
// prove the transact_2x2 SNARK and return a `SubmitTransactPayload` for
// `/v1/transact`. `buildDeposit` does NOT prove — deposits go through
// `MASP.submitIntent` (Permit2 witness); returns a `BuiltIntent` for the
// wallet to sign + POST to `/v1/intent`.

import {
    buildNoteCommitment,
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
import type { Prover } from "../prover/interface.js";
import { type Groth16Proof, type ProverPaths, prove } from "../prover/snarkjs.js";
import type { SpendKind, SubmitTransactPayload, TransactPubInputs } from "../relayer/client.js";
import { randomFr } from "../wallet/randomness.js";
import type { AuxOutput } from "./permit2.js";
import { type FlattenInput, fiatShamirZ, flatten } from "./snark-compression.js";
import {
    dummyInputAt,
    type SpendableCachedNote,
    toCircomInput,
    toSpentNoteFromPath,
} from "./witness.js";

export interface OutputRecipient {
    pk_d: Point;
    dk: Field;
    /// Note-commitment binding scalar; same value the receiver derives via
    /// `derivePkFromIvk`. Part of the bech32m address.
    pk: Field;
}

/** @internal */
/// Per-output rng material. Caller owns randomness; SDK is pure.
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
    /// Pluggable prover. Pass either:
    ///   - `proverPaths: ProverPaths` (legacy; SDK builds a SnarkjsProver)
    ///   - `prover: Prover` (custom; remote / worker / mock)
    /// Exactly one is required.
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

/// One real input slot for transfer/withdraw. Pass `null` in the
/// per-slot tuple to fill that slot with a dummy.
export interface InputSlot {
    cached: SpendableCachedNote;
    pathElements: Field[][];
    pathIndices: number[];
}

/** @internal */
/// Two-slot real-or-dummy input mask. `[a, b]` where each entry is either
/// an `InputSlot` (real spend) or `null` (dummy). At least one must be
/// non-null; balance equation enforced inside the builder.
export type InputSlots = [InputSlot | null, InputSlot | null];

/** @internal */
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

/// Shape produced by `toCircomInput`. Decimal strings fed to the prover
/// verbatim; only the public-input subset is re-parsed for the wire format.
type CircomInput = ReturnType<typeof toCircomInput>;

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
    const outputClues = auxAndWitness.map((a) => a.witness);

    const { J, asset } = common;
    // Warm WasmJubjub's circomlibjs fallback; hashToAssetGen depends on it.
    const maybeAsync = (J as { hashToAssetGenAsync?: (a: bigint) => Promise<unknown> })
        .hashToAssetGenAsync;
    if (typeof maybeAsync === "function") await maybeAsync.call(J, asset);

    const baseInput = toCircomInput(common.P, J, {
        publicAssetId: asset,
        publicIn,
        publicOut,
        inputs,
        outputs,
        outputClues,
        merkleRoot,
        recipientAddress: addrToField(common.recipientAddress),
        chainId: common.chainId,
        payerAddress: addrToField(common.payerAddress),
        relayerAddress: addrToField(common.relayerAddress),
        z: 0n,
    });

    const z = computeFiatShamirZ(baseInput, aux, outputClues);
    const proof = await runProver(common, { ...baseInput, z: z.toString() });

    return {
        payload: {
            chainId: common.chainId,
            kind,
            proof2x2: groth16ToWire(proof),
            pubInputs: extractPubInputs(common, baseInput, asset, publicIn, publicOut),
            aux: [auxToWire(aux[0]), auxToWire(aux[1])],
        },
        cm: [buildNoteCommitment(common.P, outputs[0]), buildNoteCommitment(common.P, outputs[1])],
        producedNotes: [outputs[0], outputs[1]],
    };
}

/** @internal */
/// Convert internal `OutputAux` to the wire `AuxOutput`, splitting Baby-Jubjub
/// points into x/y to mirror the on-chain `AuxValidation.Output` struct.
export function auxOutputToWire(a: OutputAux): AuxOutput {
    return {
        clueRx: a.clueR[0],
        clueRy: a.clueR[1],
        ephPubX: a.ephPub[0],
        ephPubY: a.ephPub[1],
        ciphertext: a.ciphertext,
    };
}

/** @internal */
/// Field element → 0x-hex 32 B (matches MASP `bytes32` slot encoding).
export function fieldToBytes32(f: Field): string {
    return `0x${f.toString(16).padStart(64, "0")}`;
}

/** @internal */
export function computeFiatShamirZ(
    baseInput: CircomInput,
    aux: [OutputAux, OutputAux],
    outputClues: OutputAuxWithWitness["witness"][],
): bigint {
    // Structural cast: baseInput satisfies FlattenInput but TS can't prove it.
    const flattenInput: FlattenInput = {
        ...(baseInput as unknown as FlattenInput),
        out_clue_Rx: aux.map((a) => a.clueR[0]),
        out_clue_Ry: aux.map((a) => a.clueR[1]),
        out_clue_bits: outputClues.map((c) => c.clueBits),
    };
    return fiatShamirZ(flatten(flattenInput));
}

/** @internal */
export async function runProver(
    common: BundleCommon,
    input: Record<string, unknown>,
): Promise<Groth16Proof> {
    const { proof } = common.prover
        ? await common.prover.prove(input)
        : await prove(input, common.proverPaths);
    return proof;
}

/** @internal */
/// Lift the public-input subset of the (decimal-string) circom witness back
/// into native bigints for the relayer wire format.
export function extractPubInputs(
    common: BundleCommon,
    base: CircomInput,
    asset: bigint,
    publicIn: bigint,
    publicOut: bigint,
): TransactPubInputs {
    const b = base as Record<string, string | string[] | string[][]>;
    const big = (v: string | string[] | string[][]): bigint => BigInt(v as string);
    const tuple2 = (v: string[]): [bigint, bigint] => [BigInt(v[0]), BigInt(v[1])];
    const point = (v: string[]): [bigint, bigint] => [BigInt(v[0]), BigInt(v[1])];

    const nullifier = b.nullifier as string[];
    const outCm = b.out_cm as string[];
    const inCv = b.in_cv as string[][];
    const outCv = b.out_cv as string[][];
    const outCvDep = b.out_cv_dep as string[][];

    return {
        merkleRoot: big(b.merkle_root),
        nullifier: tuple2(nullifier),
        outCm: tuple2(outCm),
        publicAssetId: asset,
        publicIn,
        publicOut,
        inCv: [point(inCv[0]), point(inCv[1])],
        outCv: [point(outCv[0]), point(outCv[1])],
        recipient: common.recipientAddress,
        chainId: common.chainId,
        payer: common.payerAddress,
        relayer: common.relayerAddress,
        outCvDep: [point(outCvDep[0]), point(outCvDep[1])],
    };
}

/** @internal */
export const addrToField = (hex: string): Field => BigInt(hex);

/** @internal */
export const groth16ToWire = (p: Groth16Proof): SubmitTransactPayload["proof2x2"] => ({
    piA: p.pi_a,
    piB: p.pi_b,
    piC: p.pi_c,
    protocol: p.protocol,
    curve: p.curve,
});

/** @internal */
export const auxToWire = (a: OutputAux): SubmitTransactPayload["aux"][number] => ({
    clueR: a.clueR,
    ephPub: a.ephPub,
    ciphertext: a.ciphertext,
});
