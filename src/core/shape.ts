// The transact circuit's input/output arity.
//
// `Transact(DEPTH, N_IN, N_OUT)` is one circom template instantiated at a
// fixed arity, and the arity reaches almost everything: how many notes a spend
// may consume, how many commitments it produces, how many coefficients the
// public-input vector carries (31 at 2×2, 42 at 3×3), and which proving key
// the prover must load.
//
// Depth is not part of this type — `WalletConfig.treeDepth` already carries
// it, and duplicating it here would let the two disagree.
//
// Tier 0 because it is pure data that `protocol/`, `circuit/`, `prover/`,
// `bundle/` and `wallet/` all need to name, the same reasoning as
// `core/note-record.ts`.

/** Input/output arity of a `Transact` instance. */
export interface CircuitShape {
    /** Notes a spend may consume. Dummies pad the unused slots. */
    nIn: number;
    /** Commitments a spend produces. Zero-value outputs pad the unused slots. */
    nOut: number;
}

/** The narrower shape. Still selectable for a 2×2 deployment. */
export const TRANSACT_2X2: CircuitShape = { nIn: 2, nOut: 2 };

/**
 * The default shape. `@lelantos-org/circuits` ships its proving and
 * verification keys from 0.8.0, and `circuit/shape-proving.test.ts` proves and
 * verifies a golden witness against them.
 */
export const TRANSACT_3X3: CircuitShape = { nIn: 3, nOut: 3 };

/**
 * Shape used when a caller does not choose one.
 *
 * A pool whose verifier and relayer are still 2×2 must say so explicitly —
 * `connect({ shape: TRANSACT_2X2 })` — because a 3×3 proof carries 42 public
 * inputs and three commitments, which a 2×2 verifier rejects.
 */
export const DEFAULT_SHAPE = TRANSACT_3X3;

/**
 * Coefficients `PubInputs.compress` emits for `shape`.
 *
 * Nine scalar slots — merkle root, the three public amounts, recipient,
 * chainId, payer, relayer, and the aux digest — plus 3 per input (nullifier
 * and the two `in_cv` coordinates) and 8 per output (`out_cm`, `out_cv`,
 * `out_cv_dep`, and three clue slots).
 *
 * 31 at 2×2, 42 at 3×3. `circuit/vectors.test.ts` checks both against the
 * `coeffCount` the circuits package publishes.
 */
export function coeffCount(shape: CircuitShape): number {
    return 9 + 3 * shape.nIn + 8 * shape.nOut;
}

/** `"2x2"`, `"3x3"` — the name the circuits package builds artifacts under. */
export function shapeId(shape: CircuitShape): string {
    return `${shape.nIn}x${shape.nOut}`;
}
