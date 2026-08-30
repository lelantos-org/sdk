// The transact circuit's input/output arity.
//
// `Transact(DEPTH, N_IN, N_OUT)` is one circom template instantiated at a
// fixed arity, and the arity reaches almost everything: how many notes a spend
// may consume, how many commitments it produces, how many coefficients the
// public-input vector carries (69 at 4×6), and which proving key the prover
// must load.
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

/**
 * The only shape `@lelantos-org/circuits` publishes artifacts for, from 0.12.1,
 * and the shape the deployed verifier accepts. `circuit/shape-proving.test.ts`
 * proves and verifies a golden witness against its keys.
 *
 * Four inputs and six outputs: a spend consumes up to four notes and emits six
 * commitments, which is what lets one spend carry its change, a shielded fee in
 * a second asset, and that asset's change without a second round.
 *
 * The three narrower shapes — 2×2, 3×3 and 4×4 — were removed in circuits
 * 0.12.0. Each cost a trusted-setup ceremony per release and 20-40 MB in every
 * install, and none covered anything this one does not. A pool still on a
 * narrower verifier cannot be served by this SDK version: there are no keys to
 * load, and a 4×6 proof carries 69 public inputs and six commitments, which a
 * narrower verifier rejects.
 */
export const TRANSACT_4X6: CircuitShape = { nIn: 4, nOut: 6 };

/**
 * Every shape the circuits package publishes artifacts for.
 *
 * The single list the cross-repo suites iterate — `circuit/vectors.test.ts`,
 * `circuit/shape-proving.test.ts`, `wallet/tx/executors.test.ts` and the
 * prover parity bench. Adding a shape to `@lelantos-org/circuits` means adding
 * it here and nowhere else; four hand-maintained copies of this list is how
 * one of them silently stops covering the newest arity.
 *
 * @internal Deliberately not re-exported from `core/index.ts` or the root
 * entrypoint: callers name the shape they deploy against, they do not
 * enumerate.
 */
export const TRANSACT_SHAPES = [TRANSACT_4X6] as const satisfies readonly CircuitShape[];

/**
 * Shape used when a caller does not choose one.
 *
 * Currently the only shape, so passing it is redundant — but callers should
 * still name it rather than rely on the default, because this is what decides
 * which artifacts resolve: `artifact-paths` names them after the shape, so
 * changing it changes which zkey a Node caller loads without asking.
 */
export const DEFAULT_SHAPE = TRANSACT_4X6;

/**
 * Coefficients `PubInputs.compress` emits for `shape`.
 *
 * Nine scalar slots — merkle root, the three public amounts, recipient,
 * chainId, payer, relayer, and the aux digest — plus 3 per input (nullifier
 * and the two `in_cv` coordinates) and 8 per output (`out_cm`, `out_cv`,
 * `out_cv_dep`, and three clue slots).
 *
 * 69 at 4×6. `circuit/vectors.test.ts` checks it against the `coeffCount` the
 * circuits package publishes.
 */
export function coeffCount(shape: CircuitShape): number {
    return 9 + 3 * shape.nIn + 8 * shape.nOut;
}

/** `"4x6"` — the name the circuits package builds artifacts under. */
export function shapeId(shape: CircuitShape): string {
    return `${shape.nIn}x${shape.nOut}`;
}
