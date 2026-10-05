// Per-output OutputAux builder. Joins ECDH `epk`, FMD clue `(R, c_bits)`,
// and ChaCha20-Poly1305 ciphertext (prefixed with 2B big-endian clueBits).
// `epk` and `R` are both multiples of the recipient address's base `g_d`.
// Paying and pad slots both go through `buildOutputAux`.

import { BABYJUB_INV8 } from "../core/field.js";
import type { Jubjub, Point } from "../crypto/jubjub.js";
import type { Field, Poseidon } from "../crypto/poseidon.js";
import { assertInvariant } from "../errors/base.js";
import { fmdFlagOnBase } from "../fmd/clue.js";
import type { FmdFlagKey } from "../fmd/keys.js";
import {
    clueBitsToPrefix,
    encodeNotePayload,
    type NotePayload,
    packClueBits,
    withClueBitsPrefix,
} from "./codec.js";
import { encryptNote } from "./encrypt.js";

/** @internal */
export interface OutputAux {
    clueR: Point;
    /**
     * Subgroup witness for `clueR`: `[8]·clueQ = clueR`. The pool doubles it
     * three times and rejects the payload unless it lands on `clueR`.
     */
    clueQ: Point;
    ephPub: Point;
    /** Wire bytes: 2B clueBits prefix || ChaCha20-Poly1305(body). */
    ciphertext: Uint8Array;
}

/** @internal */
export interface OutputAuxWithWitness {
    aux: OutputAux;
    /**
     * The clue's words of the Fiat-Shamir preimage. They are hashed into the challenge `z` and
     * are not circuit signals: a relayer cannot alter them without invalidating the proof, and
     * the circuit does not check how they were derived.
     */
    witness: {
        clueBits: Field;
        clueRx: Field;
        clueRy: Field;
    };
}

/**
 * Twisted-Edwards identity. Placeholder for a field that must be on-curve and is otherwise
 * unused. Not valid as `clueR` or `ephPub` of a submitted output: the pool rejects the identity
 * in both (`AuxValidation.validate`).
 *
 * @internal
 */
export const ON_CURVE_IDENTITY: Point = [0n, 1n];

/**
 * The witness `Q = [8^-1]R` for a clue point in the prime-order subgroup.
 *
 * @internal
 */
export function clueSubgroupWitness(J: Jubjub, clueR: Point): Point {
    return J.mulPointEscalar(clueR, BABYJUB_INV8);
}

/** @internal */
export interface BuildAuxArgs {
    J: Jubjub;
    P: Poseidon;
    /** The flag key of the recipient address: `X_i = x_i · gD`. */
    recipientFlagKey: FmdFlagKey;
    recipientPkD: Point;
    /** Base point of the recipient address, the one `note.d` names. */
    gD: Point;
    note: NotePayload;
    /** ECDH ephemeral secret: `expandSeed(note.rseed, note.rho).esk`. */
    esk: Field;
    /** FMD blinding scalar: `expandSeed(note.rseed, note.rho).fmdR`. */
    fmdR: Field;
}

/**
 * The scanner accepts the output only when `esk` and `fmdR` are the expansion of `note.rseed` and
 * `gD`, `recipientPkD` and `recipientFlagKey` belong to the address `note.d` names. None of that
 * is checked here.
 *
 * @throws {InvalidArgumentError} when `esk` or `fmdR` is zero mod q, `esk · recipientPkD` is
 * outside the prime-order subgroup, or `note` does not encode.
 * @internal
 */
export function buildOutputAux(args: BuildAuxArgs): OutputAuxWithWitness {
    const { J, P, recipientFlagKey, recipientPkD, gD, note, esk, fmdR } = args;

    const clue = fmdFlagOnBase(J, P, recipientFlagKey, gD, fmdR);
    const clueRPoint = J.unpackPoint(clue.R);
    assertInvariant(clueRPoint, "aux: clue.R failed to unpack");

    const enc = encryptNote({
        J,
        gD,
        recipientPkD,
        esk,
        plaintext: encodeNotePayload(note),
    });

    const ephPub = J.unpackPoint(enc.epk);
    assertInvariant(ephPub, "aux: epk failed to unpack");

    const prefix = clueBitsToPrefix(clue.bits, clue.gamma);
    const ciphertext = withClueBitsPrefix(prefix, enc.ciphertext);

    // Must use the packing of the wire prefix above; see `packClueBits`.
    const clueBitsField = packClueBits(clue.bits, clue.gamma);

    return {
        aux: { clueR: clueRPoint, clueQ: clueSubgroupWitness(J, clueRPoint), ephPub, ciphertext },
        witness: {
            clueBits: clueBitsField,
            clueRx: clueRPoint[0],
            clueRy: clueRPoint[1],
        },
    };
}
