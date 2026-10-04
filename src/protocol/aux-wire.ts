// `OutputAux` <-> `AuxOutput`: the builder-side shape (points) and the wire
// shape (split x/y, mirroring the on-chain `AuxValidation.Output` struct).
// Both directions live in one file so a field added to one is added to the other.

import type { OutputAux } from "../notes/aux.js";
import type { AuxOutput } from "./deposit-request.js";

/**
 * `OutputAux` to the wire `AuxOutput`: each Baby-Jubjub point split into x/y.
 *
 * @internal
 */
export function auxOutputToWire(a: OutputAux): AuxOutput {
    return {
        clueRx: a.clueR[0],
        clueRy: a.clueR[1],
        clueQx: a.clueQ[0],
        clueQy: a.clueQ[1],
        ephPubX: a.ephPub[0],
        ephPubY: a.ephPub[1],
        ciphertext: a.ciphertext,
    };
}

/** Inverse of `auxOutputToWire`: the wire `AuxOutput` to the point-tuple `OutputAux`. */
export function auxOutputFromWire(a: AuxOutput): OutputAux {
    return {
        clueR: [a.clueRx, a.clueRy],
        clueQ: [a.clueQx, a.clueQy],
        ephPub: [a.ephPubX, a.ephPubY],
        ciphertext: a.ciphertext,
    };
}
