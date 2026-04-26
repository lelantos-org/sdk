// `OutputAux` <-> `AuxOutput`: the builder-side shape (points) and the wire
// shape (split x/y, mirroring the on-chain `AuxValidation.Output` struct).
//
// Both directions live here so a field added to one cannot miss the other.

import type { OutputAux } from "../notes/aux.js";
import type { AuxOutput } from "./deposit-intent.js";

/**
 * Convert internal `OutputAux` to the wire `AuxOutput`, splitting Baby-Jubjub
 * points into x/y to mirror the on-chain `AuxValidation.Output` struct.
 *
 * @internal
 */
export function auxOutputToWire(a: OutputAux): AuxOutput {
    return {
        clueRx: a.clueR[0],
        clueRy: a.clueR[1],
        ephPubX: a.ephPub[0],
        ephPubY: a.ephPub[1],
        ciphertext: a.ciphertext,
    };
}

/**
 * Inverse of `auxOutputToWire`: flat-scalar wire `AuxOutput` (piHash shape)
 * → point-tuple `OutputAux` (builder/relayer shape) for swap.
 */
export function auxOutputFromWire(a: AuxOutput): OutputAux {
    return {
        clueR: [a.clueRx, a.clueRy],
        ephPub: [a.ephPubX, a.ephPubY],
        ciphertext: a.ciphertext,
    };
}
