// Web-Crypto-backed CSPRNG helpers. Uses rejection sampling for uniform
// field elements and non-zero subgroup scalars.
//
// `requireWebCrypto` is the single availability guard for the whole SDK.

import { fromLeBytes } from "./bytes.js";
import { EnvironmentError } from "./errors.js";
import { BABYJUB_SUBGROUP_ORDER, BN254_FR, type Field } from "./field.js";

/**
 * The platform CSPRNG.
 *
 * @throws {EnvironmentError} when `globalThis.crypto.getRandomValues` is
 * absent (old Node without the global, or a stripped browser sandbox).
 */
export function requireWebCrypto(): Crypto {
    const c = globalThis.crypto;
    if (!c?.getRandomValues) {
        throw new EnvironmentError(
            "Web Crypto API not available (globalThis.crypto.getRandomValues); " +
                "provide a polyfill, or run on Node >= 24 / a secure browser context",
        );
    }
    return c;
}

/** `n` cryptographically random bytes. */
export function randomBytes(n: number): Uint8Array {
    const out = new Uint8Array(n);
    requireWebCrypto().getRandomValues(out);
    return out;
}

/** Uniform Fr (BN254 scalar field), non-zero. */
export function randomFr(): Field {
    for (;;) {
        const b = randomBytes(32);
        b[31]! &= 0x3f;
        const v = fromLeBytes(b);
        if (v !== 0n && v < BN254_FR) return v;
    }
}

/** Uniform non-zero scalar mod the Baby-Jubjub subgroup order. */
export function randomJubjubScalar(): Field {
    for (;;) {
        const b = randomBytes(32);
        b[31]! &= 0x07;
        const v = fromLeBytes(b);
        if (v !== 0n && v < BABYJUB_SUBGROUP_ORDER) return v;
    }
}

/** Uniform 256-bit unsigned integer (Permit2 nonces). */
export function randomU256(): bigint {
    let n = 0n;
    for (const b of randomBytes(32)) n = (n << 8n) | BigInt(b);
    return n;
}

/** Uniform float in `[0, 1)` with 56 bits of entropy (selection tiebreak). */
export function randomFloat01(): number {
    let n = 0;
    for (const b of randomBytes(7)) n = n * 256 + b;
    return n / 2 ** 56;
}

/** 8 hex chars of randomness — local note ids. */
export function shortId(): string {
    let h = "";
    for (const x of randomBytes(4)) h += x.toString(16).padStart(2, "0");
    return h;
}
