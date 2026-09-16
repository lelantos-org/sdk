// Web-Crypto-backed CSPRNG helpers. Uses rejection sampling for uniform
// field elements and non-zero subgroup scalars.
//
// `requireWebCrypto` is the single availability guard for the whole SDK.

import { EnvironmentError, InvalidArgumentError } from "../errors/config.js";
import { fromBeBytes, fromLeBytes } from "./bytes.js";
import { BABYJUB_SUBGROUP_ORDER, BN254_FR, type Field } from "./field.js";
import { bytesToBareHex } from "./hex.js";

/**
 * The platform CSPRNG.
 *
 * @throws {EnvironmentError} when `globalThis.crypto.getRandomValues` is
 * absent (a stripped browser sandbox or embedded runtime).
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
    return fromBeBytes(randomBytes(32));
}

/**
 * Uniform integer in `[0, n)`.
 *
 * Rejection-sampled rather than folding with `%` or scaling a float: both
 * spread a fixed number of outcomes over `n` buckets, which are equal only when
 * `n` divides that number. The resulting bias is small but would skew slot
 * permutations, whose purpose is to remove ordering bias.
 *
 * `bytes` is injectable so a test can force a permutation; it must behave like
 * {@link randomBytes}.
 */
export function randomBelow(n: number, bytes: (k: number) => Uint8Array = randomBytes): number {
    if (!Number.isInteger(n) || n < 1) {
        throw new InvalidArgumentError(`randomBelow: n must be a positive integer, got ${n}`, {
            argument: "n",
        });
    }
    // Largest multiple of `n` inside a 32-bit draw. Values at or above it fall
    // in the short final bucket and are redrawn. Always four bytes, so the
    // rejection rate is at most n/2^32.
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
 * Downward Fisher–Yates: every one of the `n!` orderings is equally likely,
 * provided `pick` is unbiased (hence the {@link randomBelow} default).
 *
 * `pick(k)` must return a uniform integer in `[0, k)`; tests inject one to pin
 * a specific permutation.
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
 * The id keys the nullifier memo, the spent-set passed to `markSpent`, and the
 * `only` filter in selection, so a collision retires an unrelated note as spent
 * until the next rescan. 16 bytes makes collisions negligible; 4 bytes would
 * collide with ~1% probability at 10k notes and ~69% at 100k, counts that
 * denomination decomposition and change notes reach. Never leaves the wallet.
 */
export function noteId(): string {
    return randomHex(16);
}

/**
 * `n` random bytes as bare lowercase hex (`2n` characters, no `0x`).
 *
 * The one way the SDK mints random identifiers: note ids, idempotency keys and
 * EIP-3009 nonces (prefixed by the caller).
 */
export function randomHex(n: number): string {
    return bytesToBareHex(randomBytes(n));
}
