// The transact circuit's input/output arity.
//
// `Transact(DEPTH, N_IN, N_OUT)` is one circom template instantiated at a fixed arity. The arity
// determines how many notes a spend may consume, how many commitments it produces, the
// challenge-preimage length and which proving key the prover loads.
//
// Depth is excluded: `WalletConfig.treeDepth` carries it.

/** Input/output arity of a `Transact` instance. */
export interface CircuitShape {
    /** Notes a spend may consume. Dummies pad the unused slots. */
    nIn: number;
    /** Commitments a spend produces. Zero-value outputs pad the unused slots. */
    nOut: number;
}

/**
 * The only shape `@lelantos-org/circuits` publishes artifacts for, and the shape the deployed
 * verifier accepts.
 *
 * A spend consumes up to four notes and emits six commitments, enough to carry its change, a
 * shielded fee in a second asset, and that asset's change in one round.
 */
export const TRANSACT_4X6: CircuitShape = { nIn: 4, nOut: 6 };

/**
 * Every shape the circuits package publishes artifacts for: the single list the per-shape test
 * suites iterate.
 *
 * @internal Not re-exported from `./protocol` (`entry/protocol.ts`) or the root entrypoint:
 * callers name the shape they deploy against.
 */
export const TRANSACT_SHAPES = [TRANSACT_4X6] as const satisfies readonly CircuitShape[];

/**
 * Shape used when a caller does not choose one. `artifact-paths` names artifacts after the
 * shape, so changing this default changes which zkey a Node caller loads.
 */
export const DEFAULT_SHAPE = TRANSACT_4X6;

/**
 * Words `PubInputs.compress` hashes into the Fiat-Shamir challenge `z`: the coefficients (see
 * {@link coeffCount}), the digest word, the five words the circuit has no signal for (recipient,
 * chainId, payer, relayer, intentHash), three clue words per output, and the aux digest. 38 at
 * 4×6; equals `flatten`'s output length.
 */
export function challengeWordCount(shape: CircuitShape): number {
    return 10 + shape.nIn + 4 * shape.nOut;
}

/**
 * Coefficients the polynomial `y = Σ c[k]·z^k` is evaluated over, and the words the coefficient
 * digest absorbs: `coeffs`' output length.
 *
 * Merkle root, one nullifier per input, one commitment per output, `publicAssetId` and
 * `publicOut`: 13 at 4×6, the leading words of the challenge preimage.
 *
 * `PolyEval` is affine in each coefficient and the prover knows `z` before choosing a witness
 * (the contract derives it from prover-written calldata), so the evaluation alone binds nothing.
 * The circuit outputs a Poseidon digest of its coefficients as a public signal, and the contract
 * hashes the calldata copy of that digest into `z`: the witness's coefficients are fixed before
 * `z`, and two distinct coefficient vectors agree at `z` with probability at most
 * `(coeffCount - 1) / r`.
 *
 * The remaining challenge words are not circuit signals. They are hashed into `z` and never
 * evaluated, which binds them against a tampering relayer.
 */
export function coeffCount(shape: CircuitShape): number {
    return 3 + shape.nIn + shape.nOut;
}

/** `"4x6"` — the name the circuits package builds artifacts under. */
export function shapeId(shape: CircuitShape): string {
    return `${shape.nIn}x${shape.nOut}`;
}
