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
import { buildRho, type Field, type Jubjub, type Point, type Poseidon } from "../crypto/index.js";
import { InvalidArgumentError, WalletConfigError } from "../errors/config.js";
import { FMD_DEFAULT_GAMMA, type FmdFlagKey, fmdExpandFlagKey } from "../fmd/keys.js";
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
     * Note-commitment binding scalar from the bech32m address: the receiver derives it from
     * its `ivk` and default diversifier.
     */
    pk: Field;
    /**
     * FMD clue key from the recipient's address (the public half). Expanding it yields
     * flag-key points, never detection scalars.
     */
    ck: Point;
}

/**
 * Per-output randomness, supplied by the caller.
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

/**
 * Set each output note's rho to the derivation the transact circuit enforces:
 * `rho = Poseidon(TAG_RHO, nullifier[0], out_index)`. Overrides any caller-supplied rho, so
 * no two committed output notes share a rho, and hence a future nullifier. Must run before
 * aux and commitments are built from the notes.
 *
 * @internal
 */
export function deriveOutputRho(P: Poseidon, nf0: Field, outputs: readonly Note[]): Note[] {
    return outputs.map((note, index) => ({ ...note, rho: buildRho(P, nf0, index) }));
}

/** Entries kept in {@link flagKeys}. */
const FLAG_KEY_CACHE_SIZE = 8;

/**
 * Flag keys of the most recent recipients, by `(gamma, ck)`. An expansion is a pure function of
 * the public `ck` and costs γ scalar multiplications. A spend's outputs go to few recipients (the
 * payee, the wallet's own change and pads, the relayer), and the last two recur in every spend.
 */
const flagKeys = new Map<string, FmdFlagKey>();

function flagKeyFor(J: Jubjub, P: Poseidon, ck: Point, gamma: number): FmdFlagKey {
    const key = `${gamma}:${ck[0]}:${ck[1]}`;
    const flagKey = flagKeys.get(key) ?? fmdExpandFlagKey(J, P, ck, gamma);
    // A `Map` iterates in insertion order, so re-inserting a hit keeps the first key the least
    // recently used.
    flagKeys.delete(key);
    flagKeys.set(key, flagKey);
    if (flagKeys.size > FLAG_KEY_CACHE_SIZE) {
        flagKeys.delete(flagKeys.keys().next().value as string);
    }
    return flagKey;
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
        recipientFlagKey: flagKeyFor(J, P, recipient.ck, gamma),
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
