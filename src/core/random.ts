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

/**
 * Uniform Fr (BN254 scalar field), non-zero.
 *
 * The mask keeps the draw in `[0, 2^254)`, which must stay >= `BN254_FR` or the
 * rejection loop would sample a truncated range instead of the whole field.
 * `MASK_BOUNDS` in `random.test.ts` pins that. It is otherwise free: it only
 * lifts the acceptance rate to ~76%.
 */
export function randomFr(): Field {
    for (;;) {
        const b = randomBytes(32);
        b[31]! &= 0x3f;
        const v = fromLeBytes(b);
        if (v !== 0n && v < BN254_FR) return v;
    }
}

/**
 * Uniform non-zero scalar mod the Baby-Jubjub subgroup order.
 *
 * The mask bounds the draw by `2^251`, under the same invariant as
 * {@link randomFr}: it must stay >= `BABYJUB_SUBGROUP_ORDER`.
 */
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

/** The number of distinct values in a four-byte draw. */
const SPAN32 = 2 ** 32;

/**
 * Uniform integer in `[0, n)`.
 *
 * Rejection-sampled rather than folding with `%` or scaling a float: both
 * spread a fixed number of outcomes over `n` buckets, which are equal only when
 * `n` divides that number. The resulting bias is small but would skew slot
 * permutations, whose purpose is to remove ordering bias.
 *
 * `bytes` is injectable so a test can force a permutation; it must return
 * exactly `k` bytes, like {@link randomBytes}.
 */
export function randomBelow(n: number, bytes: (k: number) => Uint8Array = randomBytes): number {
    // The upper bound is `SPAN32`, not `Number.MAX_SAFE_INTEGER`: a draw is
    // four bytes, so a larger `n` would make `SPAN32 % n === SPAN32`, leaving
    // `limit === 0` and a loop that never accepts a draw.
    if (!Number.isInteger(n) || n < 1 || n > SPAN32) {
        throw new InvalidArgumentError(`randomBelow: n must be an integer in [1, 2^32], got ${n}`, {
            argument: "n",
        });
    }
    // Largest multiple of `n` inside a 32-bit draw. Values at or above it fall
    // in the short final bucket and are redrawn. Always four bytes, so the
    // rejection rate is at most n/2^32.
    const limit = SPAN32 - (SPAN32 % n);
    for (;;) {
        const draw = bytes(4);
        if (draw.length !== 4) {
            throw new InvalidArgumentError(
                `randomBelow: bytes(4) must return 4 bytes, got ${draw.length}`,
                { argument: "bytes" },
            );
        }
        let v = 0;
        for (const b of draw) v = v * 256 + b;
        if (v < limit) return v % n;
    }
}

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
