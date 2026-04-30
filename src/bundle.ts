// High-level transact bundle builders. Promotes the logic that previously
// lived in `e2e/runner/src/bundles.ts` into the SDK so every consumer (the
// runner, the CLI, future wallet UIs) shares one witness/prove/encrypt
// pipeline.
//
// Each builder returns a fully-formed `SubmitTransactPayload` ready to POST
// to the relayer's `/v1/transact`.

import {
    type Poseidon,
    type Jubjub,
    MerkleTree,
    buildNoteCommitment,
    type Field,
    type Point,
} from "./crypto/index";
import type { Note } from "./notes";
import {
    toCircomInput,
    dummyInputAt,
    toSpentNoteFromPath,
    type SpendableCachedNote,
} from "./witness";
import { flatten, fiatShamirZ } from "./snark-compression";
import { prove, type ProverPaths, type Groth16Proof } from "./prover";
import type { Prover } from "./wallet/prover";
import { EMPTY_AUX, buildOutputAux, flagKeyFromAddressDk, type OutputAux } from "./aux";
import type { SubmitTransactPayload, TransactPubInputs } from "./relayer";

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

// ---------- DEPOSIT ----------

export interface DepositArgs extends BundleCommon {
    publicIn: bigint;
    /// Bech32m-decoded shielded address of the receiving wallet. The
    /// recipient's note-binding `pk` comes from this struct now that it is
    /// in the address payload.
    recipient: OutputRecipient;
    /// Per-output randomness for the real output (slot 0). Pad slot uses
    /// EMPTY_AUX so it does not need rng material.
    output0: { rho: Field; rcm: Field; rcv: Field; aux: OutputRandomness };
    /// Pad output (slot 1) — sits on the cm tree but value=0, no aux.
    output1Pad: { rho: Field; rcm: Field; rcv: Field };
}

export async function buildDeposit(a: DepositArgs): Promise<BuiltBundle> {
    const { P, J } = a;
    const dA = dummyInputAt(P, a.treeDepth, a.output0.rho ^ 0xa1n);
    const dB = dummyInputAt(P, a.treeDepth, a.output1Pad.rho ^ 0xb2n);

    const realOut: Note = {
        asset: a.asset,
        value: a.publicIn,
        pk: a.recipient.pk,
        rho: a.output0.rho,
        rcm: a.output0.rcm,
        rcv: a.output0.rcv,
    };
    const padOut: Note = {
        asset: a.asset,
        value: 0n,
        pk: a.recipient.pk,
        rho: a.output1Pad.rho,
        rcm: a.output1Pad.rcm,
        rcv: a.output1Pad.rcv,
    };

    const merkleRoot = new MerkleTree(P, a.treeDepth).root();

    const aux0 = buildAuxForReal(J, realOut, a.recipient, a.output0.aux);
    return finalize(a, [dA, dB], [realOut, padOut], merkleRoot, a.publicIn, 0n, [aux0, EMPTY_AUX]);
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

    const realIns = buildInputs(P, a.inputs, a.treeDepth, 0xc3n);
    const aux0 = buildAuxForReal(J, a.outputs[0], a.outputRecipients[0], a.outputRandomness[0]);
    const aux1 = buildAuxForReal(J, a.outputs[1], a.outputRecipients[1], a.outputRandomness[1]);

    return finalize(a, realIns, a.outputs, a.merkleRoot, 0n, 0n, [aux0, aux1]);
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

    const realIns = buildInputs(P, a.inputs, a.treeDepth, 0xd4n);
    const aux0 = buildAuxForReal(J, a.change[0], a.changeRecipients[0], a.changeRandomness[0]);
    const aux1 = buildAuxForReal(J, a.change[1], a.changeRecipients[1], a.changeRandomness[1]);

    return finalize(a, realIns, a.change, a.merkleRoot, 0n, a.publicOut, [aux0, aux1]);
}

function buildInputs(
    P: Poseidon,
    slots: InputSlots,
    treeDepth: number,
    salt: bigint,
): ReturnType<typeof toSpentNoteFromPath>[] {
    return slots.map((s, i) =>
        s
            ? toSpentNoteFromPath(P, s.cached, s.pathElements, s.pathIndices)
            : dummyInputAt(P, treeDepth, salt ^ BigInt(i + 1)),
    );
}

// ---------- internals ----------

function buildAuxForReal(
    J: Jubjub,
    note: Note,
    recipient: OutputRecipient,
    rng: OutputRandomness,
): OutputAux {
    const { flag } = flagKeyFromAddressDk(J, recipient.dk);
    return buildOutputAux({
        J,
        recipientFlagKey: flag,
        recipientPkD: recipient.pk_d,
        note: { asset: note.asset, value: note.value, rho: note.rho, rcm: note.rcm },
        esk: rng.esk,
        fmdR: rng.fmdR,
    });
}

async function finalize(
    common: BundleCommon,
    inputs: ReturnType<typeof dummyInputAt>[] | any,
    outputs: Note[],
    merkleRoot: Field,
    publicIn: bigint,
    publicOut: bigint,
    aux: [OutputAux, OutputAux],
): Promise<BuiltBundle> {
    const { P, J, asset } = common;
    // Warm WasmJubjub's circomlibjs fallback once; subsequent sync
    // hashToAssetGen calls inside toCircomInput depend on it.
    if (typeof (J as any).hashToAssetGenAsync === "function") {
        await (J as any).hashToAssetGenAsync(asset);
    }
    const pubGen = J.hashToAssetGen(asset);

    const baseInput = toCircomInput(P, J, {
        publicAssetId: asset,
        publicAssetGen: pubGen,
        publicIn,
        publicOut,
        inputs,
        outputs,
        merkleRoot,
        recipientAddress: addrToField(common.recipientAddress),
        chainId: common.chainId,
        payerAddress: addrToField(common.payerAddress),
        relayerAddress: addrToField(common.relayerAddress),
        z: 0n,
    });

    const coeffs = flatten(baseInput as any);
    const z = fiatShamirZ(coeffs);
    const input = { ...baseInput, z: z.toString() };

    const { proof } = common.prover
        ? await common.prover.prove(input)
        : await prove(input, common.proverPaths);
    if (!common.prover && !common.proverPaths) {
        throw new Error("BundleCommon: either `prover` or `proverPaths` is required");
    }

    const pubInputs: TransactPubInputs = {
        merkleRoot: BigInt((baseInput as any).merkle_root),
        nullifier: [
            BigInt((baseInput as any).nullifier[0]),
            BigInt((baseInput as any).nullifier[1]),
        ],
        outCm: [BigInt((baseInput as any).out_cm[0]), BigInt((baseInput as any).out_cm[1])],
        publicAssetId: asset,
        pubAssetGen: pubGen,
        publicIn,
        publicOut,
        inCv: [
            [BigInt((baseInput as any).in_cv[0][0]), BigInt((baseInput as any).in_cv[0][1])],
            [BigInt((baseInput as any).in_cv[1][0]), BigInt((baseInput as any).in_cv[1][1])],
        ],
        outCv: [
            [BigInt((baseInput as any).out_cv[0][0]), BigInt((baseInput as any).out_cv[0][1])],
            [BigInt((baseInput as any).out_cv[1][0]), BigInt((baseInput as any).out_cv[1][1])],
        ],
        recipient: common.recipientAddress,
        chainId: common.chainId,
        payer: common.payerAddress,
        relayer: common.relayerAddress,
    };

    const payload: SubmitTransactPayload = {
        chainId: common.chainId,
        proof2x2: groth16ToWire(proof),
        pubInputs,
        aux: [auxToWire(aux[0]), auxToWire(aux[1])],
    };

    const cm0 = buildNoteCommitment(P, outputs[0]);
    const cm1 = buildNoteCommitment(P, outputs[1]);
    return { payload, cm: [cm0, cm1], producedNotes: [outputs[0], outputs[1]] };
}

function addrToField(hex: string): Field {
    return BigInt(hex);
}

function groth16ToWire(p: Groth16Proof): SubmitTransactPayload["proof2x2"] {
    return { piA: p.pi_a, piB: p.pi_b, piC: p.pi_c, protocol: p.protocol, curve: p.curve };
}

function auxToWire(a: OutputAux): SubmitTransactPayload["aux"][number] {
    return { clueR: a.clueR, ephPub: a.ephPub, ciphertext: a.ciphertext };
}
