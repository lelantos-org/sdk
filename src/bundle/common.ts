// Shared bundle types and builder helpers for deposit, transfer and withdraw.

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
import { diversifiedBase } from "../crypto/diversified-base.js";
import type { Field, Jubjub, Point, Poseidon } from "../crypto/index.js";
import { InvalidArgumentError, WalletConfigError } from "../errors/config.js";
import { fmdDiversifiedFlagKey } from "../fmd/diversified.js";
import { FMD_DEFAULT_GAMMA, type FmdFlagKey } from "../fmd/keys.js";
import { diversifierToBytes } from "../keys/diversifier.js";
import { buildOutputAux, type OutputAux, type OutputAuxWithWitness } from "../notes/aux.js";
import { EMPTY_MEMO } from "../notes/codec.js";
import type { Note } from "../notes/note.js";
import { deriveOutputSecret, expandSeed, seedFromSecret } from "../notes/seed.js";
import { auxDigest } from "../protocol/abi-hash.js";
import { auxOutputToWire } from "../protocol/aux-wire.js";
import type { CircuitShape } from "../protocol/shape.js";
import type { SpendKind, SubmitTransactPayload, TransactPubInputs } from "../protocol/transact.js";
import type { Groth16Proof, Prover, ProverArtifacts } from "../prover/types.js";

/** The address an output is sealed to: the fields of a decoded shielded address. */
export interface OutputRecipient {
    /** Diversifier, in `[0, 2^128)`. Selects the base `g_d` the output's ECDH and clue run on. */
    d: Field;
    /** ECDH target: `ivk · g_d`. */
    pk_d: Point;
    /** Note-commitment binding scalar: `Poseidon(TAG_PK, ivk, d)`. */
    pk: Field;
    /**
     * FMD clue key: `dk_root · g_d`. Expanding it yields flag-key points, never detection
     * scalars.
     */
    ck_d: Point;
    /**
     * Set for an address no later output is sealed to (a pad's). Its base and flag key are
     * expanded without entering the cache of recent recipients.
     */
    oneTime?: boolean;
}

/** One output slot: what it pays and to whom. */
export interface OutputSpec {
    asset: bigint;
    value: bigint;
    recipient: OutputRecipient;
    /** The memo field the output's plaintext carries (`encodeMemo`). Omit for none. */
    memo?: Uint8Array | undefined;
}

/** @internal */
export interface BundleCommon {
    P: Poseidon;
    J: Jubjub;
    chainId: bigint;
    /**
     * Registry id `publicOut` leaves the pool in. Published as `publicAssetId` only when
     * `publicOut` is non-zero.
     */
    asset: bigint;
    payerAddress: string; // 0x ETH, non-zero: the pool reverts `ZeroPayer`
    /**
     * 0x ETH. The relayer's submitter address (`/chains` `relayerAddress`): the pool's
     * `msg.sender` for its spends, so it must equal `pi.relayer`. For a relayer submitting
     * through its `Bundler` contract this is the Bundler's address, not the signing EOA.
     */
    relayerAddress: string;
    recipientAddress: string; // 0x ETH, non-zero: the on-chain recipient of `publicOut`
    /**
     * `PubInputs.Transact.intentHash`, a field element. A swap's withdraw leg must set it to
     * `swapIntentHash` of the swap it funds; every other spend leaves it at the zero default.
     */
    intentHash?: bigint;
    /**
     * Proving backend: `artifacts` (the SDK proves with snarkjs) or a custom `prover`
     * (remote, worker, mock). One is required; `prover` takes precedence.
     */
    artifacts?: ProverArtifacts;
    prover?: Prover;
    treeDepth: number;
    /**
     * Circuit arity, when the caller knows it. Supplying it enables a pre-flight check of the
     * slot counts. `toCircomInput` infers the shape from the array lengths, so without it a
     * spend with the wrong slot count for the zkey builds a valid witness with the wrong
     * number of public inputs and fails inside the prover.
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

/** One real input slot of a spend. A `null` entry in {@link InputSlots} is a dummy. */
export interface InputSlot {
    cached: SpendableCachedNote;
    pathElements: Field[][];
    pathIndices: number[];
}

/**
 * One entry per input slot: an `InputSlot` for a real spend or `null` for a dummy. Length
 * must equal the shape's `nIn`, and at least one entry must be non-null.
 *
 * @internal
 */
export type InputSlots = readonly (InputSlot | null)[];

type SpentNoteInput = ReturnType<typeof toSpentNoteFromPath>;

/**
 * Fill every input slot, substituting a dummy for `null`. A dummy's nullifier is public: it
 * is keyed by the `nsk` of the first real slot and takes a fresh `rho` and `rcm`, so it reads
 * as a real one. Requires at least one real slot.
 *
 * @internal
 */
export function buildInputs(P: Poseidon, slots: InputSlots, treeDepth: number): SpentNoteInput[] {
    const nsk = slots.find((s): s is InputSlot => s !== null)?.cached.nsk;
    if (nsk === undefined) {
        throw new InvalidArgumentError("buildInputs: at least one real input required", {
            argument: "slots",
        });
    }
    return slots.map((s) =>
        s
            ? toSpentNoteFromPath(P, s.cached, s.pathElements, s.pathIndices)
            : dummyInputAt(P, treeDepth, { nsk, rho: randomFr(), rcm: randomFr() }),
    );
}

/** What sealing to one address needs beyond the address itself. */
interface AddressKeys {
    /** The address's base, `diversifiedBase(d)`. */
    gD: Point;
    /** The clue key `ck_d` expanded on `gD`, `FMD_DEFAULT_GAMMA` points. */
    flagKey: FmdFlagKey;
}

function expandAddress(J: Jubjub, P: Poseidon, recipient: OutputRecipient): AddressKeys {
    const gD = diversifiedBase(J, P, recipient.d);
    return { gD, flagKey: fmdDiversifiedFlagKey(J, P, recipient.ck_d, gD, FMD_DEFAULT_GAMMA) };
}

/** Entries kept in {@link recentAddressKeys}. */
const ADDRESS_KEY_CACHE_SIZE = 8;

/**
 * The expansions of the most recent recipients, least recently used first, keyed by `(d, ck_d)`:
 * every input of an expansion, which costs γ scalar multiplications. The wallet's own change
 * address and the relayer's recur in every spend.
 */
const recentAddressKeys = new Map<string, AddressKeys>();

/** {@link expandAddress}, remembered unless the address is `oneTime`. */
function addressKeysFor(J: Jubjub, P: Poseidon, recipient: OutputRecipient): AddressKeys {
    if (recipient.oneTime) return expandAddress(J, P, recipient);
    const key = `${recipient.d}:${recipient.ck_d[0]}:${recipient.ck_d[1]}`;
    const keys = recentAddressKeys.get(key) ?? expandAddress(J, P, recipient);
    // A `Map` iterates in insertion order: re-inserting a hit moves it to the end.
    recentAddressKeys.delete(key);
    recentAddressKeys.set(key, keys);
    if (recentAddressKeys.size > ADDRESS_KEY_CACHE_SIZE) {
        recentAddressKeys.delete(recentAddressKeys.keys().next().value as string);
    }
    return keys;
}

/** An output as {@link sealOutput} takes it, with its memo field resolved. */
type SealArgs = Parameters<typeof sealOutput>[2] & { memo: Uint8Array };

/**
 * `osk` of an output: the secret all its randomness derives from. The one binding of an output's
 * fields into `deriveOutputSecret`, shared by sealing and by the payment proof that recomputes it.
 *
 * @throws {InvalidArgumentError} as {@link sealOutput} does for the fields `osk` binds.
 * @internal
 */
export function outputSecret(J: Jubjub, o: SealArgs): Uint8Array {
    const { recipient } = o;
    return deriveOutputSecret(o.outgoingKey, {
        chainId: o.chainId,
        rho: o.rho,
        asset: o.asset,
        value: o.value,
        d: diversifierToBytes(recipient.d),
        pk_d: J.packPoint(recipient.pk_d),
        pk: recipient.pk,
        ck_d: J.packPoint(recipient.ck_d),
        nullifiers: o.nullifiers,
        memo: o.memo,
    });
}

/**
 * Seal one output: its note, and the clue, ephemeral key and ciphertext published with it.
 *
 * No random value is drawn. `osk` ({@link outputSecret}) binds the sender's outgoing key, the
 * chain, the note's fields, the recipient's whole address, the spend's nullifiers and the memo;
 * the header of `notes/seed.ts` defines its preimage and how `rseed`, `rcm`, `esk` and `fmdR`
 * follow from it. Two calls therefore share an `esk` only when every one of those is equal. `rho`
 * must be unique per output: it is the note's nullifier seed.
 *
 * ECDH and the clue run on the recipient's base `g_d = diversifiedBase(d)`. The clue has
 * `FMD_DEFAULT_GAMMA` bits, the width a recipient checks. A pad goes through this function like a
 * paying output, to an address drawn for it.
 *
 * @throws {InvalidArgumentError} when `outgoingKey` is not 32 bytes, `memo` is not 128 bytes,
 * `rho`, `recipient.pk` or a nullifier is not a canonical field element, `asset` or `value` is not
 * a uint64, `recipient.d` is not in `[0, 2^128)`, or `recipient.pk_d` is not in the prime-order
 * subgroup.
 */
export function sealOutput(
    J: Jubjub,
    P: Poseidon,
    o: {
        /** The sender's outgoing key (`deriveOutgoingKey`). */
        outgoingKey: Uint8Array;
        chainId: bigint;
        rho: Field;
        asset: bigint;
        value: bigint;
        recipient: OutputRecipient;
        /**
         * The spend's public nullifiers, one per input slot in slot order, dummy slots included.
         * Empty for a deposit.
         */
        nullifiers: readonly Field[];
        /** The memo field of the plaintext (`encodeMemo`). Omit for none. */
        memo?: Uint8Array | undefined;
    },
): { note: Note; aux: OutputAuxWithWitness } {
    const { rho, asset, value, recipient, memo = EMPTY_MEMO } = o;
    const rseed = seedFromSecret(outputSecret(J, { ...o, memo }));
    const { rcm, esk, fmdR } = expandSeed(rseed, rho);
    const { gD, flagKey } = addressKeysFor(J, P, recipient);
    const aux = buildOutputAux({
        J,
        P,
        recipientFlagKey: flagKey,
        recipientPkD: recipient.pk_d,
        gD,
        note: { asset, value, rho, rseed, d: recipient.d, memo },
        esk,
        fmdR,
    });
    return { note: { asset, value, pk: recipient.pk, rho, rcm }, aux };
}

/** @internal */
export async function finalize(
    common: BundleCommon,
    kind: SpendKind,
    inputs: readonly SpentNoteInput[],
    outputs: readonly Note[],
    merkleRoot: Field,
    publicOut: bigint,
    auxAndWitness: readonly OutputAuxWithWitness[],
): Promise<BuiltBundle> {
    // Resolved before the witness is built, so a missing backend fails fast.
    const prove = proverFor(common);
    const intentHash = common.intentHash ?? 0n;
    // The contract compares the full uint256 word; an unreduced value would make the proof
    // bind a different word than the wrapper recomputes.
    assertField(intentHash, "intentHash");
    const aux: OutputAux[] = auxAndWitness.map((a) => a.aux);

    // A spend that withdraws nothing names no asset: the circuit enforces
    // `public_out == 0 ⇒ public_asset_id == 0` and the pool's `transfer` reverts
    // `MustNotNameAsset`.
    const publicAssetId = publicOut === 0n ? 0n : common.asset;

    const baseInput = toCircomInput(common.P, {
        publicAssetId,
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
    // `circuitSignals` drops the challenge-only fields: they are hashed into `z` above but are
    // not circuit signals, and the witness calculator rejects a key the circuit does not declare.
    const proof = await prove({ ...circuitSignals({ ...baseInput, z: z.toString() }) });

    return {
        payload: {
            chainId: common.chainId,
            kind,
            proof: groth16ToWire(proof),
            pubInputs: extractPubInputs(common, baseInput),
            aux: [...aux],
        },
        // Read back from the witness, where `toCircomInput` hashed each output commitment, so
        // the value the proof commits to has one source.
        cm: baseInput.out_cm.map((c) => BigInt(c)),
        producedNotes: [...outputs],
    };
}

/** The configured proving backend, as a function from circuit input to proof. */
function proverFor(
    common: BundleCommon,
): (input: Record<string, unknown>) => Promise<Groth16Proof> {
    const { prover, artifacts } = common;
    if (prover) return async (input) => (await prover.prove(input)).proof;
    if (!artifacts) {
        throw new WalletConfigError("BundleCommon: either `prover` or `artifacts` is required");
    }
    return async (input) => {
        // Imported lazily: a static import would make the optional `snarkjs` peer mandatory
        // for every `./protocol` consumer.
        const { SnarkjsProver } = await import("../prover/snarkjs.js");
        return (await new SnarkjsProver(artifacts).prove(input)).proof;
    };
}

/**
 * Parse the public-input subset of the circom witness (decimal strings) into bigints for the
 * relayer wire format.
 *
 * @internal
 */
function extractPubInputs(common: BundleCommon, base: TransactWitnessBundle): TransactPubInputs {
    const scalars = (v: readonly string[]): bigint[] => v.map((x) => BigInt(x));

    return {
        merkleRoot: BigInt(base.merkle_root),
        nullifier: scalars(base.nullifier),
        outCm: scalars(base.out_cm),
        publicAssetId: BigInt(base.public_asset_id),
        publicOut: BigInt(base.public_out),
        // The calldata copy of the circuit's `digest` output; the pool hashes it into `z` and
        // hands it to the verifier.
        digest: BigInt(base.digest),
        recipient: common.recipientAddress,
        chainId: common.chainId,
        payer: common.payerAddress,
        relayer: common.relayerAddress,
        intentHash: BigInt(base.intent_hash),
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
