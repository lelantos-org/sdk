// Point <-> byte marshalling across the wasm boundary.
//
// Wire convention: a point is two little-endian 32-byte field elements,
// x then y. Mirrors `sdk/wasm/jubjub/src/lib.rs`.

import { FIELD_BYTES, fromLeBytes, toLeBytes } from "../../core/bytes.js";
import type { Point } from "../jubjub.js";

export const POINT_BYTES = 64;

export function pointToBytes(p: Point): Uint8Array {
    const out = new Uint8Array(POINT_BYTES);
    out.set(toLeBytes(p[0], FIELD_BYTES), 0);
    out.set(toLeBytes(p[1], FIELD_BYTES), FIELD_BYTES);
    return out;
}

export function bytesToPoint(b: Uint8Array): Point {
    return [fromLeBytes(b.slice(0, FIELD_BYTES)), fromLeBytes(b.slice(FIELD_BYTES, POINT_BYTES))];
}
