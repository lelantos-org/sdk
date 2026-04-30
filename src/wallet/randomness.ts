// Web-Crypto-backed CSPRNG helpers for fresh note + permit material.
//
// Works in browser, Node 19+, and Deno without polyfills (`globalThis.crypto`
// is the WHATWG Crypto API). Uses rejection sampling for uniform field
// elements + non-zero subgroup scalars.

import { BABYJUB_SUBGROUP_ORDER, BN254_FR, fromLeBytes, type Field } from "../crypto/index";

function randomBytes32(): Uint8Array {
    const out = new Uint8Array(32);
    if (!globalThis.crypto?.getRandomValues) {
        throw new Error("Web Crypto API not available; provide a polyfill");
    }
    globalThis.crypto.getRandomValues(out);
    return out;
}

/// Uniform Fr (BN254 scalar field) via rejection sampling.
export function randomFr(): Field {
    for (;;) {
        const b = randomBytes32();
        b[31] &= 0x3f;
        const v = fromLeBytes(b);
        if (v !== 0n && v < BN254_FR) return v;
    }
}

/// Uniform non-zero scalar mod the Baby-Jubjub subgroup order.
export function randomJubjubScalar(): Field {
    for (;;) {
        const b = randomBytes32();
        b[31] &= 0x07;
        const v = fromLeBytes(b);
        if (v !== 0n && v < BABYJUB_SUBGROUP_ORDER) return v;
    }
}
