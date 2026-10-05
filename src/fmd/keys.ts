// FMD receiver keys and the γ policy.
//
// See `./clue.ts` for the scheme. Receiver keys over a base point B:
//   detection key   dk = (x_1, ..., x_γ) ∈ Z_q^γ
//   flag key        fk = (X_1, ..., X_γ) where X_i = B · x_i
//
// `./diversified.ts` derives both from one root scalar, on the base `g_d` of an address.

// Leaf imports, not the barrel, to keep the worker bundle minimal.
import { BABYJUB_SUBGROUP_ORDER } from "../core/field.js";
import type { Jubjub, Point } from "../crypto/jubjub.js";
import type { Field } from "../crypto/poseidon.js";
import { InvalidArgumentError } from "../errors/config.js";

/**
 * γ every sender emits, the default detection γ, and the ceiling on any detection γ.
 *
 * Fixed pool-wide: a sender does not know the recipient's detection γ. The circuit does not
 * constrain the clue; its words are bound to the proof through the Fiat-Shamir challenge only.
 *
 * A clue packs `c_1..c_γ` into a 16-bit prefix with the unused bits zero (`clueBitsToPrefix`),
 * while `fmdTest` requires `bit_i ⊕ c_i = 1` for every `i` in the detection key. A longer
 * detection key tests its trailing bits against zero padding, so a genuine note survives with
 * probability `2^-(γ_detect - γ_sender)`.
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
    // `gamma = 0` would produce an empty key, which `fmdTest` accepts against any zero-γ clue.
    assertDetectionGamma(gamma);
    const x = Array.from({ length: gamma }, () => {
        const xi = randomScalar() % BABYJUB_SUBGROUP_ORDER;
        return xi === 0n ? 1n : xi;
    });
    return { x };
}

/** The flag key of `dk` over `base`: `X_i = x_i · base`. */
export function fmdFlagKeyFromDetection(J: Jubjub, dk: FmdDetectionKey, base: Point): FmdFlagKey {
    return { X: dk.x.map((xi) => J.mulPointEscalar(base, xi)) };
}
