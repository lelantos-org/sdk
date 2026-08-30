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

/**
 * Uniform integer in `[0, n)`.
 *
 * Rejection-sampled rather than folding a random draw with `%` or scaling a
 * float: either spreads a fixed number of outcomes over `n` buckets, which are
 * equal in size only when `n` divides that number. The bias is tiny at small
 * `n` but it is a bias in a slot permutation, which is exactly the thing the
 * permutation exists to remove.
 *
 * `bytes` is injectable so a test can force a permutation; it must behave like
 * {@link randomBytes}.
 */
export function randomBelow(n: number, bytes: (k: number) => Uint8Array = randomBytes): number {
    if (!Number.isInteger(n) || n < 1) {
        throw new RangeError(`randomBelow: n must be a positive integer, got ${n}`);
    }
    // Largest multiple of `n` inside a 32-bit draw. Values at or above it fall
    // in the short final bucket, which has fewer than `n` members, so they are
    // redrawn rather than folded. Four bytes for every `n` rather than the
    // narrowest that fits: the spare entropy is free at these call rates, and
    // the rejection rate is then at most n/2^32.
    const limit = SPAN32 - (SPAN32 % n);
    for (;;) {
        let v = 0;
        for (const b of bytes(4)) v = v * 256 + b;
        if (v < limit) return v % n;
    }
}

const SPAN32 = 2 ** 32;

/**
 * A uniformly random permutation of `items`, as a new array.
 *
 * Fisher–Yates, downwards, so every one of the `n!` orderings is equally
 * likely — given an unbiased `pick`, which is why the default is
 * {@link randomBelow} and not a scaled float.
 *
 * `pick(k)` must return a uniform integer in `[0, k)`; injecting one is how a
 * test pins a specific permutation.
 */
export function shuffled<T>(items: readonly T[], pick: (n: number) => number = randomBelow): T[] {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i--) {
        const j = pick(i + 1);
        [out[i], out[j]] = [out[j]!, out[i]!];
    }
    return out;
}

/**
 * A local note id: 32 hex chars, 128 bits of randomness.
 *
 * Wide because the id is an identity, not a display label. It keys the
 * nullifier memo, the spent-set passed to `markSpent`, and the `only` filter
 * in selection — so two notes sharing one means an unrelated note is retired
 * as spent and withheld from the selector until the next rescan.
 *
 * The previous 4 bytes made that a birthday problem over a wallet's note
 * count: ~1% at 10k notes and ~69% at 100k, which denomination decomposition
 * and per-spend change notes reach. At 16 bytes it is not a consideration.
 * Nothing outside the wallet ever sees this value.
 */
export function noteId(): string {
    let h = "";
    for (const x of randomBytes(16)) h += x.toString(16).padStart(2, "0");
    return h;
}
