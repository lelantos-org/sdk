// Per-output OutputAux builder. Joins ECDH `epk`, FMD clue `(R, c_bits)`,
// and ChaCha20-Poly1305 ciphertext (prefixed with 2B big-endian clueBits).
// Both real and pad slots go through `buildOutputAux`.

import { bitAt } from "../core/bits.js";
import { BABYJUB_SUBGROUP_ORDER } from "../core/field.js";
import type { Jubjub, Point } from "../crypto/jubjub.js";
import type { Field, Poseidon } from "../crypto/poseidon.js";
import {
    FMD_DEFAULT_GAMMA,
    type FmdDetectionKey,
    type FmdFlagKey,
    fmdFlag,
    fmdFlagKeyFromDetection,
    fmdGenDetectionKey,
} from "../fmd/fmd.js";
import {
    clueBitsToPrefix,
    encodeNotePayload,
    type NotePayload,
    withClueBitsPrefix,
} from "./codec.js";
import { encryptNote } from "./encrypt.js";

/** @internal */
export interface OutputAux {
    clueR: Point;
    ephPub: Point;
    /** Wire bytes: 2B clueBits prefix || ChaCha20-Poly1305(body). */
    ciphertext: Uint8Array;
}

/** @internal */
export interface OutputAuxWithWitness {
    aux: OutputAux;
    /**
     * Plain public inputs for the clue: client-computed off-circuit,
     * PolyEval-bound to the proof. Relayer cannot alter without invalidating.
     */
    witness: {
        clueBits: Field;
        clueRx: Field;
        clueRy: Field;
    };
}

/**
 * Twisted-Edwards identity. Use as a placeholder for fields where on-curve
 * is required but the value is unused (e.g. pad-output `aux.ephPub` when
 * no plaintext exists). Note: SNARK-bound `clueR` cannot use this — the
 * circuit forces `R = r·G_8` for any witnessed `r ≠ 0`.
 *
 * @internal
 */
export const ON_CURVE_IDENTITY: Point = [0n, 1n];

/** @internal */
export interface BuildAuxArgs {
    J: Jubjub;
    P: Poseidon;
    recipientFlagKey: FmdFlagKey;
    recipientPkD: Point;
    note: NotePayload;
    /** ECDH ephemeral secret, fresh per output. MUST be uniform in Z_q*. */
    esk: Field;
    /** FMD blinding scalar, fresh per output. MUST be uniform in Z_q*. */
    fmdR: Field;
}

/** @internal */
export function buildOutputAux(args: BuildAuxArgs): OutputAuxWithWitness {
    const { J, P, recipientFlagKey, recipientPkD, note, esk, fmdR } = args;

    const clue = fmdFlag(J, P, recipientFlagKey, fmdR);
    const clueRPoint = J.unpackPoint(clue.R);
    if (!clueRPoint) throw new Error("aux: clue.R failed to unpack");

    const enc = encryptNote({
        J,
        recipientPkD,
        esk,
        plaintext: encodeNotePayload(note),
    });

    const ephPub = J.unpackPoint(enc.epk);
    if (!ephPub) throw new Error("aux: epk failed to unpack");

    const prefix = clueBitsToPrefix(clue.bits, clue.gamma);
    const ciphertext = withClueBitsPrefix(prefix, enc.ciphertext);

    // Re-pack clueBits as a single field element, LSB-first within γ bits.
    let clueBitsField: bigint = 0n;
    for (let i = 0; i < clue.gamma; i++) {
        if (bitAt(clue.bits, i)) clueBitsField |= 1n << BigInt(i);
    }

    return {
        aux: { clueR: clueRPoint, ephPub, ciphertext },
        witness: {
            clueBits: clueBitsField,
            clueRx: clueRPoint[0],
            clueRy: clueRPoint[1],
        },
    };
}

/**
 * Convenience: derive a deterministic flag-key from a single scalar `dkSeed`
 * (the `dk` field in a bech32m address). Each γ-component scalar is mixed
 * from `dkSeed` via a counter, matching the receiver's wallet that
 * generates its detection key from the same seed.
 */
export function flagKeyFromAddressDk(
    J: Jubjub,
    dkSeed: Field,
    gamma: number = FMD_DEFAULT_GAMMA,
): { detection: FmdDetectionKey; flag: FmdFlagKey } {
    let n = dkSeed;
    const stream = (): Field => {
        n = (n + 0x9e3779b97f4a7c15n) % BABYJUB_SUBGROUP_ORDER;
        return n === 0n ? 1n : n;
    };
    const detection = fmdGenDetectionKey(stream, gamma);
    const flag = fmdFlagKeyFromDetection(J, detection);
    return { detection, flag };
}
