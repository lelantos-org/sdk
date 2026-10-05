// Byte conversions for field elements.
//
// Little-endian is the default: on-chain serialisation uses 32-byte LE. The
// big-endian pair serves the wasm Poseidon boundary, whose wire contract is BE.

import { InvalidArgumentError } from "../errors/config.js";
import type { Field } from "./field.js";

/** Width of a serialised field element, in bytes. */
export const FIELD_BYTES = 32;

export function toLeBytes(x: Field, len = FIELD_BYTES): Uint8Array {
    const out = new Uint8Array(len);
    let v = x;
    for (let i = 0; i < len; i++) {
        out[i] = Number(v & 0xffn);
        v >>= 8n;
    }
    if (v !== 0n) {
        throw new InvalidArgumentError(`field exceeds ${len} bytes`, { argument: "value" });
    }
    return out;
}

export function fromLeBytes(b: Uint8Array): Field {
    let v = 0n;
    for (let i = b.length - 1; i >= 0; i--) v = (v << 8n) | BigInt(b[i]!);
    return v;
}

/**
 * Write `x` big-endian into `dst` at `offset`, over `FIELD_BYTES`.
 *
 * Writes in place so a hot path can reuse one scratch buffer without allocating
 * per call. Unlike `toLeBytes`, does not check for overflow: every caller has
 * already run `assertField`.
 */
export function writeBeInto(dst: Uint8Array, offset: number, x: Field): void {
    let v = x;
    for (let i = FIELD_BYTES - 1; i >= 0; i--) {
        dst[offset + i] = Number(v & 0xffn);
        v >>= 8n;
    }
}

export function fromBeBytes(b: Uint8Array): Field {
    let v = 0n;
    for (const byte of b) v = (v << 8n) | BigInt(byte);
    return v;
}

/** Whether `a` and `b` hold the same bytes. Returns at the first difference: for public values. */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
}

/**
 * `bytes` is exactly `length` bytes long.
 *
 * @throws {InvalidArgumentError} otherwise.
 * @internal
 */
export function assertByteLength(bytes: Uint8Array, length: number, what: string): void {
    if (bytes.length !== length) {
        throw new InvalidArgumentError(`${what} must be ${length} bytes; got ${bytes.length}`, {
            argument: what,
        });
    }
}
