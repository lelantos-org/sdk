// Modular square root + Legendre and Jacobi symbols over the BN254 scalar field.
// Consumed by FMD bit derivation (`fmdSharedBit` in `fmd/clue.ts`) and by the (bit, y) witness of
// `fmdLegendreWitness`.
// BN254 has 2-adicity 28 (r-1 = 2^28 · q): full Tonelli–Shanks required, no shortcut formula.

import { BN254_FR, FMD_LEGENDRE_QNR } from "../core/field.js";
import { assertInvariant } from "../errors/base.js";
import { InvalidArgumentError } from "../errors/config.js";

function mod(a: bigint, p: bigint): bigint {
    const r = a % p;
    return r < 0n ? r + p : r;
}

function modPow(base: bigint, exp: bigint, p: bigint): bigint {
    let r = 1n;
    let b = mod(base, p);
    let e = exp;
    while (e > 0n) {
        if (e & 1n) r = (r * b) % p;
        e >>= 1n;
        b = (b * b) % p;
    }
    return r;
}

/** @internal */
export function modInverse(a: bigint, p: bigint): bigint {
    return modPow(a, p - 2n, p);
}

/**
 * The Legendre symbol `(a / p)` over an odd prime `p`, by Euler's criterion: one exponentiation by
 * the fixed exponent `(p - 1) / 2`, whatever `a` is. `fmdTest` relies on that; where running time
 * may follow `a`, `jacobiSymbol` gives the same answer several times faster.
 *
 * @internal
 */
export function legendreSymbol(a: bigint, p: bigint): -1 | 0 | 1 {
    const am = mod(a, p);
    if (am === 0n) return 0;
    const ls = modPow(am, (p - 1n) / 2n, p);
    return ls === 1n ? 1 : -1;
}

/**
 * The Jacobi symbol `(a / n)` of any integer `a` over an odd positive `n`, by quadratic
 * reciprocity: a Euclidean reduction with no exponentiation, whose number of steps varies with
 * `a`.
 *
 * For a prime `n` it is the Legendre symbol, and equals `legendreSymbol(a, n)` for every `a`.
 *
 * @throws {InvalidArgumentError} when `n` is even or not positive.
 * @internal
 */
export function jacobiSymbol(a: bigint, n: bigint): -1 | 0 | 1 {
    if (n <= 0n || (n & 1n) === 0n) {
        throw new InvalidArgumentError("jacobi symbol: n must be odd and positive", {
            argument: "n",
        });
    }
    // Invariant: the result is `±(x / m)` with `m` odd, the sign held in `negative`.
    let x = mod(a, n);
    let m = n;
    let negative = false;
    while (x !== 0n) {
        // (2 / m) = -1 iff m ≡ ±3 (mod 8).
        const m8 = m & 7n;
        const flipsOnTwo = m8 === 3n || m8 === 5n;
        while ((x & 1n) === 0n) {
            x >>= 1n;
            if (flipsOnTwo) negative = !negative;
        }
        // (x / m) = -(m / x) iff x ≡ m ≡ 3 (mod 4), for odd x and m.
        if ((x & m & 3n) === 3n) negative = !negative;
        const next = m % x;
        m = x;
        x = next;
    }
    // `m` is gcd(a, n): the symbol is zero unless they are coprime.
    if (m !== 1n) return 0;
    return negative ? -1 : 1;
}

/** @internal */
export function modSqrt(n: bigint, p: bigint): bigint | null {
    const nm = mod(n, p);
    if (nm === 0n) return 0n;
    if (legendreSymbol(nm, p) !== 1) return null;

    // Factor p-1 = 2^s · q with q odd.
    let q = p - 1n;
    let s = 0n;
    while ((q & 1n) === 0n) {
        q >>= 1n;
        s++;
    }

    // Any QNR z works. BN254 Fr takes the constant from `core/field.ts` instead of searching.
    let z: bigint;
    if (p === BN254_FR) {
        z = FMD_LEGENDRE_QNR;
    } else {
        z = 2n;
        while (legendreSymbol(z, p) !== -1) z++;
    }

    let m = s;
    let c = modPow(z, q, p);
    let t = modPow(nm, q, p);
    let r = modPow(nm, (q + 1n) / 2n, p);

    while (true) {
        if (t === 1n) return r;
        let i = 0n;
        let tmp = t;
        while (tmp !== 1n) {
            tmp = (tmp * tmp) % p;
            i++;
            if (i === m) return null;
        }
        const b = modPow(c, 1n << (m - i - 1n), p);
        m = i;
        c = (b * b) % p;
        t = (t * c) % p;
        r = (r * b) % p;
    }
}

/** @internal */
// Witness pair for the Legendre bit of a hash, with Z = FMD_LEGENDRE_QNR. bit=1 ⇒ hash is QR and
// y² = hash; bit=0 ⇒ hash is QNR and y² · Z = hash. Throws on hash=0 (probability 1/r; treated as
// an internal error).
export function fmdLegendreWitness(h: bigint): { bit: 0 | 1; y: bigint } {
    const sym = legendreSymbol(h, BN254_FR);
    assertInvariant(sym !== 0, "FMD legendre witness: hash collided to zero");
    if (sym === 1) {
        const y = modSqrt(h, BN254_FR);
        assertInvariant(y !== null, "FMD legendre witness: sqrt failed for QR");
        return { bit: 1, y };
    }
    const zInv = modInverse(FMD_LEGENDRE_QNR, BN254_FR);
    const y = modSqrt(mod(h * zInv, BN254_FR), BN254_FR);
    assertInvariant(y !== null, "FMD legendre witness: sqrt failed for QNR/Z");
    return { bit: 0, y };
}
