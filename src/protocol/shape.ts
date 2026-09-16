// The transact circuit's input/output arity.
//
// `Transact(DEPTH, N_IN, N_OUT)` is one circom template instantiated at a fixed
// arity. The arity determines how many notes a spend may consume, how many
// commitments it produces, the public-input vector length (70 at 4×6), and
// which proving key the prover loads.
//
// Depth is excluded: `WalletConfig.treeDepth` carries it, and a second copy
// could disagree.
//
// Protocol tier (3): pure data that `circuit/`, `prover/`, `bundle/` and `wallet/` all name, as
// with `protocol/note-record.ts`.

/** Input/output arity of a `Transact` instance. */
export interface CircuitShape {
    /** Notes a spend may consume. Dummies pad the unused slots. */
    nIn: number;
    /** Commitments a spend produces. Zero-value outputs pad the unused slots. */
    nOut: number;
}

/**
 * The only shape `@lelantos-org/circuits` publishes artifacts for, and the shape
 * the deployed verifier accepts. `circuit/shape-proving.test.ts` proves and
 * verifies a golden witness against its keys.
 *
 * A spend consumes up to four notes and emits six commitments, enough to carry
 * its change, a shielded fee in a second asset, and that asset's change in one
 * round.
 *
 * Pools on a narrower verifier (2×2, 3×3, 4×4) are unsupported: no keys exist
 * for those shapes, and a 4×6 proof carries 70 public inputs and six
 * commitments, which a narrower verifier rejects.
 */
export const TRANSACT_4X6: CircuitShape = { nIn: 4, nOut: 6 };

/**
 * Every shape the circuits package publishes artifacts for.
 *
 * The single list the cross-repo suites iterate (`circuit/vectors.test.ts`,
 * `circuit/shape-proving.test.ts`, `wallet/tx/executors.test.ts`, the prover
 * parity bench). A shape added to `@lelantos-org/circuits` is added here and
 * nowhere else, so no suite can silently miss it.
 *
 * @internal Deliberately not re-exported from `./protocol` (`entry/protocol.ts`) or the root
 * entrypoint: callers name the shape they deploy against, they do not
 * enumerate.
 */
export const TRANSACT_SHAPES = [TRANSACT_4X6] as const satisfies readonly CircuitShape[];

/**
 * Shape used when a caller does not choose one.
 *
 * Callers should name their shape explicitly: `artifact-paths` names artifacts
 * after the shape, so changing this default changes which zkey a Node caller
 * loads.
 */
export const DEFAULT_SHAPE = TRANSACT_4X6;

/**
 * Words `PubInputs.compress` hashes into the Fiat-Shamir challenge `z`.
 *
 * Ten scalar slots (merkle root, the three public amounts, recipient, chainId,
 * payer, relayer, intentHash, aux digest), plus 3 per input (nullifier and the
 * two `in_cv` coordinates) and 8 per output (`out_cm`, `out_cv`, `out_cv_dep`,
 * three clue slots). 70 at 4×6; equals `flatten`'s output length.
 */
export function challengeWordCount(shape: CircuitShape): number {
    return 10 + 3 * shape.nIn + 8 * shape.nOut;
}

/**
 * Coefficients the polynomial `y = Σ c[k]·z^k` is evaluated over: a strict
 * subset of the challenge words, and `coeffs`' output length.
 *
 * Four scalar slots (merkle root and the three public amounts), plus 3 per
 * input (nullifier and the two `in_cv` coordinates) and 5 per output (`out_cm`,
 * `out_cv`, `out_cv_dep`). 46 at 4×6.
 *
 * Excluding recipient, chainId, payer, relayer, intentHash, the FMD clue
 * triples and the aux digest is a soundness requirement. `PolyEval` is affine
 * in each coefficient and the prover knows `z` before choosing a witness (the
 * contract derives it from prover-written calldata), so an unconstrained
 * coefficient is one linear equation in one unknown: solving it makes arbitrary
 * calldata verify against a proof of an unrelated transaction. These 24 fields
 * have no in-circuit constraint, so they are hashed into `z` but never
 * evaluated, which binds them against a tampering relayer.
 *
 * `circuit/vectors.test.ts` checks both counts against what the circuits
 * package publishes.
 */
export function coeffCount(shape: CircuitShape): number {
    return 4 + 3 * shape.nIn + 5 * shape.nOut;
}

/** `"4x6"` — the name the circuits package builds artifacts under. */
export function shapeId(shape: CircuitShape): string {
    return `${shape.nIn}x${shape.nOut}`;
}
