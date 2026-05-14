// Modular square root + Legendre symbol over the BN254 scalar field.
// Consumed by FMD bit derivation (sdk/src/fmd.ts:sharedBit) and by the (bit, y) witness for
// the `HashToBit` gadget in circuits/src/lib/hash_to_bit.circom.
// BN254 has 2-adicity 28 (r-1 = 2^28 · q): full Tonelli–Shanks required, no shortcut formula.

import { BN254_FR, FMD_LEGENDRE_QNR } from "./tags.js";

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

export function modInverse(a: bigint, p: bigint): bigint {
    return modPow(a, p - 2n, p);
}

export function legendreSymbol(a: bigint, p: bigint): -1 | 0 | 1 {
    const am = mod(a, p);
    if (am === 0n) return 0;
    const ls = modPow(am, (p - 1n) / 2n, p);
    return ls === 1n ? 1 : -1;
}

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

    // Find any QNR z.
    let z = 2n;
    while (legendreSymbol(z, p) !== -1) z++;

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

// Witness pair for HashToBit. bit=1 ⇒ hash is QR and y² = hash; bit=0 ⇒ hash is QNR and
// y² · Z = hash. Throws on hash=0 (probability 1/r — indicates a bug).
export function fmdLegendreWitness(h: bigint): { bit: 0 | 1; y: bigint } {
    const sym = legendreSymbol(h, BN254_FR);
    if (sym === 0) throw new Error("FMD legendre witness: hash collided to zero");
    if (sym === 1) {
        const y = modSqrt(h, BN254_FR);
        if (y === null) throw new Error("FMD legendre witness: sqrt failed for QR");
        return { bit: 1, y };
    }
    const zInv = modInverse(FMD_LEGENDRE_QNR, BN254_FR);
    const y = modSqrt(mod(h * zInv, BN254_FR), BN254_FR);
    if (y === null) throw new Error("FMD legendre witness: sqrt failed for QNR/Z");
    return { bit: 0, y };
}
