// Narrow runtime validators for inbound wire data. Dependency-free, so no
// schema library becomes a hard runtime dependency of the package.
//
// Every helper takes a JSON path, so a malformed response raises a
// `WireFormatError` naming the offending value rather than a TypeError deep
// inside a deserializer.
//
// INBOUND ONLY. Outbound payloads are constructed by the SDK and are not
// re-validated.

import { WireFormatError } from "./errors.js";

function fail(path: string, expected: string, got: unknown): never {
    const desc =
        got === null
            ? "null"
            : Array.isArray(got)
              ? `array(${got.length})`
              : typeof got === "object"
                ? "object"
                : `${typeof got} ${JSON.stringify(got)?.slice(0, 40)}`;
    throw new WireFormatError(path, `expected ${expected}, got ${desc}`);
}

export function obj(v: unknown, path: string): Record<string, unknown> {
    if (typeof v !== "object" || v === null || Array.isArray(v)) fail(path, "an object", v);
    return v as Record<string, unknown>;
}

export function arr(v: unknown, path: string): unknown[] {
    if (!Array.isArray(v)) fail(path, "an array", v);
    return v;
}

/** Fixed-length array. Length is part of most of these wire contracts. */
export function arrN(v: unknown, path: string, n: number): unknown[] {
    const a = arr(v, path);
    if (a.length !== n) fail(path, `an array of length ${n}`, v);
    return a;
}

export function str(v: unknown, path: string): string {
    if (typeof v !== "string") fail(path, "a string", v);
    return v;
}

/** Strict: `0`, `1`, `"true"` and `null` are all rejected. */
export function bool(v: unknown, path: string): boolean {
    if (typeof v !== "boolean") fail(path, "a boolean", v);
    return v;
}

/** A safe integer. Rejects floats, NaN and anything past 2^53. */
export function int(v: unknown, path: string): number {
    if (typeof v !== "number" || !Number.isSafeInteger(v)) fail(path, "a safe integer", v);
    return v;
}

const DECIMAL = /^-?\d+$/;
const HEX = /^0[xX][0-9a-fA-F]+$/;
const HEX_BODY = /^[0-9a-fA-F]*$/;

/**
 * A field element as a decimal string, a `0x`-hex string, or a JSON number.
 *
 * Accepts all three for the relayer, whose Rust DTOs disagree field by field
 * (`String` here, `u64` there — see `services/relayer/codec.ts`). Only use it
 * where the wire form is genuinely not pinned: a field known to be hex must go
 * through `hexInt`, or a bare-hex value made only of decimal digits decodes as
 * the wrong number.
 */
export function bigintFrom(v: unknown, path: string): bigint {
    if (typeof v === "bigint") return v;
    if (typeof v === "number") return BigInt(int(v, path));
    if (typeof v === "string" && (DECIMAL.test(v) || HEX.test(v))) return BigInt(v);
    return fail(path, "a decimal or 0x-hex integer", v);
}

/**
 * A hex integer, `0x`-prefixed or bare.
 *
 * Deliberately separate from `bigintFrom`: a bare-hex field whose value
 * happens to be all decimal digits ("1234") is also a valid decimal string, so
 * routing bare hex through `bigintFrom` decodes the wrong number silently.
 * Use this wherever the server emits hex without the prefix.
 */
export function hexInt(v: unknown, path: string): bigint {
    const s = str(v, path);
    const body = s.startsWith("0x") || s.startsWith("0X") ? s.slice(2) : s;
    if (body.length === 0 || !HEX_BODY.test(body)) fail(path, "a hex integer", v);
    return BigInt(`0x${body}`);
}

/** Hex bytes, `0x`-prefixed or bare. Rejects odd length and non-hex. */
export function hexBytes(v: unknown, path: string): Uint8Array {
    const s = str(v, path);
    const body = s.startsWith("0x") || s.startsWith("0X") ? s.slice(2) : s;
    if (body.length % 2 !== 0 || !HEX_BODY.test(body)) {
        fail(path, "an even-length hex string", v);
    }
    const out = new Uint8Array(body.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(body.slice(2 * i, 2 * i + 2), 16);
    return out;
}

/** Exactly-two tuple, e.g. an (x, y) curve point. */
export function tuple2<T>(v: unknown, path: string, f: (x: unknown, p: string) => T): [T, T] {
    const a = arrN(v, path, 2);
    return [f(a[0], `${path}[0]`), f(a[1], `${path}[1]`)];
}

/** Map over an array, threading the index into the error path. */
export function mapArr<T>(v: unknown, path: string, f: (x: unknown, p: string) => T): T[] {
    return arr(v, path).map((x, i) => f(x, `${path}[${i}]`));
}

/** `undefined` and `null` both pass through as `undefined`. */
export function opt<T>(v: unknown, path: string, f: (x: unknown, p: string) => T): T | undefined {
    return v === undefined || v === null ? undefined : f(v, path);
}
