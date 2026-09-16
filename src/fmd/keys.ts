// FMD receiver keys: generation, expansion from a root secret, and the γ policy.
//
// See `./clue.ts` for the scheme. Receiver keys:
//   detection key   dk = (x_1, ..., x_γ) ∈ Z_q^γ
//   flag key        fk = (X_1, ..., X_γ) where X_i = B · x_i
//
// Key expansion. Both γ-component keys derive on demand from a single scalar;
// only the public half appears in an address:
//
//   root secret  dk_root ∈ Z_q          never published
//   clue key     ck = B · dk_root       published (32 B, packed) in the address
//   h_i = Poseidon(TAG_FMD_EXPAND, ck.x, ck.y, i) mod q     public
//   x_i = dk_root + h_i  (mod q)        recipient; requires dk_root
//   X_i = ck + B · h_i                  sender; computable from ck alone
//
// X_i = (dk_root + h_i)·B = x_i·B, and recovering x_i from ck is a discrete
// log on Baby-Jubjub, so publishing `ck` grants the ability to flag for a
// recipient, not to detect for them. Follows Penumbra's S-FMD
// ClueKey/DetectionKey split (additive derivation, `decaf377-fmd::hkd`) over
// Baby-Jubjub + Poseidon.
//
// `h_i` is public, so a delegate holding any single `x_i` recovers
// dk_root = x_i - h_i and every other x_i. Detection delegation is
// all-or-nothing, non-revocable, and cannot be precision-bounded.

// Leaf imports, not the barrel, to keep the worker bundle minimal.
import { BABYJUB_SUBGROUP_ORDER } from "../core/field.js";
import type { Jubjub, Point } from "../crypto/jubjub.js";
import type { Field, Poseidon } from "../crypto/poseidon.js";
import { TAG_FMD_EXPAND } from "../crypto/tags.js";
import { InvalidArgumentError } from "../errors/config.js";

/**
 * γ every sender emits, the default detection γ, and the ceiling on any detection γ.
 *
 * Circuit-pinned: `out_clue_bits` is a public input constrained by
 * `ClueCheck`, so raising it is a `@lelantos-org/circuits` change.
 *
 * A clue packs `c_1..c_γ` into a 16-bit prefix with the unused bits zero
 * (`clueBitsToPrefix`), while `fmdTest` requires `bit_i ⊕ c_i = 1` for every
 * `i` in the detection key. A longer detection key tests trailing bits against
 * zero padding, each passing only when the recipient's shared bit is 1, so a
 * genuine note survives with probability `2^-(γ_detect - γ_sender)`.
 */
export const FMD_DEFAULT_GAMMA = 5;

/**
 * Reject a detection γ above `FMD_DEFAULT_GAMMA`. A higher γ does not lower the
 * false-positive rate; it discards the recipient's own notes.
 */
export function assertDetectionGamma(gamma: number): void {
    if (!Number.isInteger(gamma) || gamma < 1) {
        throw new InvalidArgumentError(`FMD gamma must be a positive integer; got ${gamma}`, {
            argument: "gamma",
        });
    }
    if (gamma > FMD_DEFAULT_GAMMA) {
        throw new InvalidArgumentError(
            `FMD gamma ${gamma} exceeds the sender gamma ${FMD_DEFAULT_GAMMA}: senders pack ` +
                `${FMD_DEFAULT_GAMMA} clue bits and zero-pad the rest, so detecting at ${gamma} ` +
                `would miss ~${missedOwnNotesPct(gamma)}% of your own notes rather than ` +
                "admitting more decoys",
            { argument: "gamma" },
        );
    }
}

/**
 * Percentage of the recipient's own notes a detection key of `gamma` rejects.
 * Detection survives with probability `2^-(gamma - FMD_DEFAULT_GAMMA)`.
 */
function missedOwnNotesPct(gamma: number): number {
    const detected = 2 ** -(gamma - FMD_DEFAULT_GAMMA);
    return Math.round((1 - detected) * 100);
}

export interface FmdDetectionKey {
    x: Field[];
}
export interface FmdFlagKey {
    X: Point[];
}
export function fmdGenDetectionKey(
    randomScalar: () => Field,
    gamma = FMD_DEFAULT_GAMMA,
): FmdDetectionKey {
    // Rejects `gamma <= 0` with a typed error; `gamma = 0` would produce an
    // empty key that `fmdTest` accepts against any zero-γ clue.
    assertDetectionGamma(gamma);
    const x = Array.from({ length: gamma }, () => {
        const xi = randomScalar() % BABYJUB_SUBGROUP_ORDER;
        return xi === 0n ? 1n : xi;
    });
    return { x };
}

export function fmdFlagKeyFromDetection(J: Jubjub, dk: FmdDetectionKey): FmdFlagKey {
    return { X: dk.x.map((xi) => J.mulPointEscalar(J.base8, xi)) };
}

/** Public clue key `ck = B · dk_root`, the value published in an address. */
export function fmdClueKeyFromRoot(J: Jubjub, dkRoot: Field): Point {
    return J.mulPointEscalar(J.base8, dkRoot % BABYJUB_SUBGROUP_ORDER);
}

// h_i = Poseidon(TAG_FMD_EXPAND, ck.x, ck.y, i) mod q. `ck` is bound into the
// hash so that no two receivers share an expansion.
//
// Reducing a Poseidon output (uniform in [0, r), r ~ 2^254.86) mod q ~ 2^251.03
// is non-uniform by a factor 8/7 at the low end. h_i is an additive blinder on
// a secret rather than a secret itself, so rejection sampling is unnecessary.
function expandScalar(P: Poseidon, ck: Point, i: number): Field {
    return P.hash([TAG_FMD_EXPAND, ck[0], ck[1], BigInt(i)]) % BABYJUB_SUBGROUP_ORDER;
}

/**
 * Expand a published clue key into the γ flag-key points, `X_i = ck + B·h_i`.
 * Sender side; requires no secret input.
 */
export function fmdExpandFlagKey(
    J: Jubjub,
    P: Poseidon,
    ck: Point,
    gamma = FMD_DEFAULT_GAMMA,
): FmdFlagKey {
    return {
        X: Array.from({ length: gamma }, (_, i) =>
            J.addPoint(ck, J.mulPointEscalar(J.base8, expandScalar(P, ck, i))),
        ),
    };
}

/**
 * Expand the root secret into the γ detection scalars,
 * `x_i = dk_root + h_i (mod q)`, the discrete logs of `fmdExpandFlagKey`'s
 * output. Receiver side.
 *
 * Must not apply `fmdGenDetectionKey`'s zero-scalar fixup: remapping a zero
 * `x_i` here and not in the flag key would desynchronise the two halves. A zero
 * `x_i` (probability ~2^-251) yields a constant clue bit on both sides, which
 * keeps them consistent.
 */
export function fmdExpandDetectionKey(
    J: Jubjub,
    P: Poseidon,
    dkRoot: Field,
    gamma = FMD_DEFAULT_GAMMA,
): FmdDetectionKey {
    // No γ guard: this raw primitive is pinned against the Rust indexer by
    // cross-language vectors at several γ. `FMD_DEFAULT_GAMMA` is enforced at
    // the policy boundary (`detectionKeyFor`, `detectionKey`,
    // `FmdClient.createSubscription`).
    const root = dkRoot % BABYJUB_SUBGROUP_ORDER;
    const ck = fmdClueKeyFromRoot(J, root);
    return {
        x: Array.from(
            { length: gamma },
            (_, i) => (root + expandScalar(P, ck, i)) % BABYJUB_SUBGROUP_ORDER,
        ),
    };
}
