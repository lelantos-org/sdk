// High-level transact bundle builders. Promotes the logic that previously
// lived in `e2e/runner/src/bundles.ts` into the SDK so every consumer (the
// runner, the CLI, future wallet UIs) shares one witness/prove/encrypt
// pipeline.
//
// Two flavors:
//   - Spend builders (`buildTransfer`, `buildWithdraw`, `buildWithdrawNative`)
//     prove the transact_2x2 SNARK and return a `SubmitTransactPayload` ready
//     to POST to the relayer's `/v1/transact`.
//   - `buildDeposit` does NOT prove — under the new escrow flow, deposits go
//     through `MASP.submitIntent` (Permit2 witness, no SNARK at submit). It
//     returns a `BuiltIntent` ready for the wallet to sign + POST to
//     `/v1/intent`.

import {
    buildOutputAux,
    flagKeyFromAddressDk,
    type OutputAux,
    type OutputAuxWithWitness,
} from "./aux.js";
import {
    buildNoteCommitment,
    type Field,
    type Jubjub,
    type Point,
    type Poseidon,
} from "./crypto/index.js";
import type { Note } from "./notes.js";
import type { AuxOutput, DepositIntent } from "./permit2.js";
import { type Groth16Proof, type ProverPaths, prove } from "./prover.js";
import type { SpendKind, SubmitTransactPayload, TransactPubInputs } from "./relayer.js";
import { BN254_R, type FlattenInput, fiatShamirZ, flatten } from "./snark-compression.js";
import type { Prover } from "./wallet/prover.js";
import { randomFr } from "./wallet/randomness.js";
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
    /// `derivePkFromIvk`. Now part of the bech32m address.
    pk: Field;
}

/// Per-output rng material. Caller owns randomness; SDK is pure.
export interface OutputRandomness {
    esk: Field;
    fmdR: Field;
}

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

export interface BuiltBundle {
    payload: SubmitTransactPayload;
    cm: [Field, Field];
    producedNotes: [Note, Note];
}

// ---------- DEPOSIT (escrow intent — no SNARK) ----------

export interface DepositArgs {
    P: Poseidon;
    J: Jubjub;
    chainId: bigint;
    asset: bigint;
    /// 0x ETH; payer's account (Permit2 transfer source).
    payerAddress: string;
    /// 0x ETH; on-chain recipient (binds DepositIntent.recipient).
    recipientAddress: string;
    publicIn: bigint;
    /// Bech32m-decoded shielded address of the receiving wallet. The
    /// recipient's note-binding `pk` comes from this struct now that it is
    /// in the address payload.
    recipient: OutputRecipient;
    /// Per-output randomness for the real output (slot 0).
    output0: { rho: Field; rcm: Field; rcv: Field; rcvDep: Field; aux: OutputRandomness };
    /// Pad output (slot 1) — gets a real FMD clue + ECDH so the recipient's
    /// indexer can match it the same way as the real note.
    output1Pad: { rho: Field; rcm: Field; rcv: Field; rcvDep: Field };
}

export interface BuiltIntent {
    /// Plaintext DepositIntent — the wallet hashes this with `aux` to derive
    /// the Permit2 witness `piHash`, then signs the Permit2 typed-data.
    intent: DepositIntent;
    /// Per-output FMD clue + ECDH + ciphertext. Bound into `piHash`.
    aux: [AuxOutput, AuxOutput];
    cm: [Field, Field];
    producedNotes: [Note, Note];
}

export function buildDeposit(a: DepositArgs): BuiltIntent {
    const { P, J } = a;

    const realOut: Note = {
        asset: a.asset,
        value: a.publicIn,
        pk: a.recipient.pk,
        rho: a.output0.rho,
        rcm: a.output0.rcm,
        rcv: a.output0.rcv,
        rcvDep: a.output0.rcvDep,
    };
    const padOut: Note = {
        asset: a.asset,
        value: 0n,
        pk: a.recipient.pk,
        rho: a.output1Pad.rho,
        rcm: a.output1Pad.rcm,
        rcv: a.output1Pad.rcv,
        rcvDep: a.output1Pad.rcvDep,
    };

    const aux0 = buildAuxForReal(J, P, realOut, a.recipient, a.output0.aux);
    const aux1 = buildAuxForReal(J, P, padOut, a.recipient, {
        esk: randomFr(),
        fmdR: randomFr(),
    });

    const cm0 = buildNoteCommitment(P, realOut);
    const cm1 = buildNoteCommitment(P, padOut);

    // Deposit-anchor Pedersen value commitments. cv_dep_j = value_j · V^asset
    // + rcv_dep_j · H. Baked into the leaf via Poseidon(TAG_LEAF, cm, cv_dep)
    // so the spender cannot open the cm under a different (asset, value) at
    // spend time. Closes C-1 (cm-preimage substitution on deposit path).
    const assetGen = J.hashToAssetGen(a.asset);
    const cvDep0 = J.valueCommit(realOut.value, assetGen, realOut.rcvDep);
    const cvDep1 = J.valueCommit(padOut.value, assetGen, padOut.rcvDep);
    const rcvTotal = (realOut.rcvDep + padOut.rcvDep) % BN254_R;

    const intent: DepositIntent = {
        chainId: a.chainId,
        publicAssetId: a.asset,
        publicIn: a.publicIn,
        payer: a.payerAddress,
        recipient: a.recipientAddress,
        outCm: [fieldToBytes32(cm0), fieldToBytes32(cm1)],
        cvDep0: [cvDep0[0], cvDep0[1]],
        cvDep1: [cvDep1[0], cvDep1[1]],
        rcvTotal,
    };

    return {
        intent,
        aux: [auxOutputToWire(aux0.aux), auxOutputToWire(aux1.aux)],
        cm: [cm0, cm1],
        producedNotes: [realOut, padOut],
    };
}

// ---------- INPUT SLOT ----------

/// One real input slot for transfer/withdraw. Pass `null` in the
/// per-slot tuple to fill that slot with a dummy.
export interface InputSlot {
    cached: SpendableCachedNote;
    pathElements: Field[][];
    pathIndices: number[];
}

/// Two-slot real-or-dummy input mask. `[a, b]` where each entry is either
/// an `InputSlot` (real spend) or `null` (dummy). At least one must be
/// non-null; balance equation enforced inside the builder.
export type InputSlots = [InputSlot | null, InputSlot | null];

// ---------- TRANSFER ----------

export interface TransferArgs extends BundleCommon {
    inputs: InputSlots;
    merkleRoot: Field;
    /// Two output notes summing to total real-input value.
    outputs: [Note, Note];
    /// Recipient address per output slot (used to build FMD clue + ECDH).
    /// Pass own address for change slots.
    outputRecipients: [OutputRecipient, OutputRecipient];
    outputRandomness: [OutputRandomness, OutputRandomness];
}

export async function buildTransfer(a: TransferArgs): Promise<BuiltBundle> {
    const { P, J } = a;
    if (a.inputs.every((s) => s == null))
        throw new Error("transfer: at least one real input required");

    const sumIn = a.inputs.reduce((acc, s) => acc + (s?.cached.note.value ?? 0n), 0n);
    const sumOut = a.outputs[0].value + a.outputs[1].value;
    if (sumOut !== sumIn) {
        throw new Error(`transfer balance: in=${sumIn} out=${sumOut}`);
    }

    const realIns = buildInputs(P, a.inputs, a.treeDepth);
    const aux0 = buildAuxForReal(J, P, a.outputs[0], a.outputRecipients[0], a.outputRandomness[0]);
    const aux1 = buildAuxForReal(J, P, a.outputs[1], a.outputRecipients[1], a.outputRandomness[1]);

    return finalize(a, "transfer", realIns, a.outputs, a.merkleRoot, 0n, 0n, [aux0, aux1]);
}

// ---------- WITHDRAW ----------

export interface WithdrawArgs extends BundleCommon {
    inputs: InputSlots;
    merkleRoot: Field;
    publicOut: bigint;
    /// Two change notes (back to self), summing to total real-input value − publicOut.
    change: [Note, Note];
    changeRecipients: [OutputRecipient, OutputRecipient];
    changeRandomness: [OutputRandomness, OutputRandomness];
}

export async function buildWithdraw(a: WithdrawArgs): Promise<BuiltBundle> {
    const { P, J } = a;
    if (a.inputs.every((s) => s == null))
        throw new Error("withdraw: at least one real input required");

    const sumIn = a.inputs.reduce((acc, s) => acc + (s?.cached.note.value ?? 0n), 0n);
    const sumChange = a.change[0].value + a.change[1].value;
    if (sumIn !== a.publicOut + sumChange) {
        throw new Error(
            `withdraw balance: in=${sumIn} publicOut=${a.publicOut} change=${sumChange}`,
        );
    }

    const realIns = buildInputs(P, a.inputs, a.treeDepth);
    const aux0 = buildAuxForReal(J, P, a.change[0], a.changeRecipients[0], a.changeRandomness[0]);
    const aux1 = buildAuxForReal(J, P, a.change[1], a.changeRecipients[1], a.changeRandomness[1]);

    return finalize(a, "withdraw", realIns, a.change, a.merkleRoot, 0n, a.publicOut, [aux0, aux1]);
}

// ---------- WITHDRAW NATIVE (WETH → ETH) ----------

export interface WithdrawNativeArgs extends WithdrawArgs {}

/// Same shape as `buildWithdraw` but tags the payload `kind: "withdrawNative"`
/// so the relayer routes to `MASP.withdrawNative`. The MASP contract unwraps
/// WETH and forwards raw ETH to `recipientAddress`. Caller is responsible
/// for ensuring `asset` is the registered WETH asset id.
export async function buildWithdrawNative(a: WithdrawNativeArgs): Promise<BuiltBundle> {
    const { P, J } = a;
    if (a.inputs.every((s) => s == null))
        throw new Error("withdrawNative: at least one real input required");

    const sumIn = a.inputs.reduce((acc, s) => acc + (s?.cached.note.value ?? 0n), 0n);
    const sumChange = a.change[0].value + a.change[1].value;
    if (sumIn !== a.publicOut + sumChange) {
        throw new Error(
            `withdrawNative balance: in=${sumIn} publicOut=${a.publicOut} change=${sumChange}`,
        );
    }

    const realIns = buildInputs(P, a.inputs, a.treeDepth);
    const aux0 = buildAuxForReal(J, P, a.change[0], a.changeRecipients[0], a.changeRandomness[0]);
    const aux1 = buildAuxForReal(J, P, a.change[1], a.changeRecipients[1], a.changeRandomness[1]);

    return finalize(a, "withdrawNative", realIns, a.change, a.merkleRoot, 0n, a.publicOut, [
        aux0,
        aux1,
    ]);
}

function buildInputs(
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

// ---------- internals ----------

function buildAuxForReal(
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

// ── finalize: pure pipeline (witness → flatten → prove → wire payload) ──

/// Shape produced by `toCircomInput`. Decimal strings — fed to the prover
/// verbatim; we only re-parse the public-input subset for the wire format.
type CircomInput = ReturnType<typeof toCircomInput>;

async function finalize(
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
    // Warm WasmJubjub's circomlibjs fallback once; per-note hashToAssetGen
    // calls inside toCircomInput depend on it.
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

/// Convert an internal `OutputAux` (pair of points + bytes) to the wire
/// `AuxOutput` shape consumed by Permit2 piHash + relayer wire. Splits the
/// Baby-Jubjub points into separate x/y coordinates to mirror the on-chain
/// `AuxValidation.Output` struct.
function auxOutputToWire(a: OutputAux): AuxOutput {
    return {
        clueRx: a.clueR[0],
        clueRy: a.clueR[1],
        ephPubX: a.ephPub[0],
        ephPubY: a.ephPub[1],
        ciphertext: a.ciphertext,
    };
}

/// Field element → 0x-hex 32 B (matches MASP `bytes32` slot encoding).
function fieldToBytes32(f: Field): string {
    return `0x${f.toString(16).padStart(64, "0")}`;
}

function computeFiatShamirZ(
    baseInput: CircomInput,
    aux: [OutputAux, OutputAux],
    outputClues: OutputAuxWithWitness["witness"][],
): bigint {
    // `baseInput` is the generic Record returned by `toCircomInput`; structurally
    // matches FlattenInput's required slots but TS can't prove it without the
    // unknown bridge.
    const flattenInput: FlattenInput = {
        ...(baseInput as unknown as FlattenInput),
        out_clue_Rx: aux.map((a) => a.clueR[0]),
        out_clue_Ry: aux.map((a) => a.clueR[1]),
        out_clue_bits: outputClues.map((c) => c.clueBits),
    };
    return fiatShamirZ(flatten(flattenInput));
}

async function runProver(
    common: BundleCommon,
    input: Record<string, unknown>,
): Promise<Groth16Proof> {
    const { proof } = common.prover
        ? await common.prover.prove(input)
        : await prove(input, common.proverPaths);
    return proof;
}

/// Lift the public-input subset of the (decimal-string) circom witness back
/// into native bigints for the relayer wire format.
function extractPubInputs(
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

const addrToField = (hex: string): Field => BigInt(hex);

const groth16ToWire = (p: Groth16Proof): SubmitTransactPayload["proof2x2"] => ({
    piA: p.pi_a,
    piB: p.pi_b,
    piC: p.pi_c,
    protocol: p.protocol,
    curve: p.curve,
});

const auxToWire = (a: OutputAux): SubmitTransactPayload["aux"][number] => ({
    clueR: a.clueR,
    ephPub: a.ephPub,
    ciphertext: a.ciphertext,
});
