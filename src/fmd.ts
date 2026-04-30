// Fuzzy Message Detection — FMD2 (Beck & Len, 2021), a.k.a. Niwl.
//
// Tunable false-positive rate p = 2^-γ. Default γ = 5 ⇒ 1/32 FP.
//
// Receiver keys:
//   detection key   dk = (x_1, ..., x_γ) ∈ Z_q^γ
//   flag key        fk = (X_1, ..., X_γ) where X_i = B · x_i
//
// Sender flags a message for fk:
//   r ← Z_q*
//   R = B · r
//   for i ∈ [γ]: bit_i = lsb(H(domain, R, i, r·X_i))   ;   c_i = bit_i ⊕ 1
//   clue = (R, c_1 || ... || c_γ)
//
// Receiver tests with dk:
//   for i ∈ [γ]: bit_i = lsb(H(domain, R, i, x_i·R))
//                if bit_i ⊕ c_i ≠ 1 → reject
//
// Honest recipient: r·X_i == x_i·R, so all γ checks pass.
// Anyone else: each check independent random ⇒ accept with prob 2^-γ.
//
// Wire format:
//   encoded clue = γ (1B) || R_packed (32B) || c_bits (⌈γ/8⌉ B, LSB-first)
//
// `scripts/gen-fmd-vectors.ts` writes deterministic vectors that lock byte
// order against the Rust indexer impl. Do not change format without bumping
// FMD_DOMAIN.

import { blake2b } from "@noble/hashes/blake2";
import {
    Jubjub,
    BABYJUB_SUBGROUP_ORDER,
    type Field,
    type Point,
} from "./crypto/index";
import { WasmJubjub } from "./crypto/jubjub-wasm";
import { toLeBytes, FIELD_BYTES } from "./crypto/bytes";

export const FMD_DEFAULT_GAMMA = 5;
export const FMD_DOMAIN = new TextEncoder().encode("lelantos.fmd.v1");

export interface FmdDetectionKey { x: Field[]; }
export interface FmdFlagKey { X: Point[]; }
export interface FmdClue { R: Uint8Array; bits: Uint8Array; gamma: number; }

export function fmdGenDetectionKey(
    randomScalar: () => Field,
    gamma = FMD_DEFAULT_GAMMA,
): FmdDetectionKey {
    const x = Array.from({ length: gamma }, () => {
        const xi = randomScalar() % BABYJUB_SUBGROUP_ORDER;
        return xi === 0n ? 1n : xi;
    });
    return { x };
}

export function fmdFlagKeyFromDetection(J: Jubjub, dk: FmdDetectionKey): FmdFlagKey {
    return { X: dk.x.map(xi => J.mulPointEscalar(J.base8, xi)) };
}

export function fmdFlag(J: Jubjub, fk: FmdFlagKey, r: Field): FmdClue {
    const gamma = fk.X.length;
    const rMod = r % BABYJUB_SUBGROUP_ORDER;
    if (rMod === 0n) throw new Error("fmd flag: r must be non-zero mod q");

    const R = J.mulPointEscalar(J.base8, rMod);
    const Rpacked = J.packPoint(R);

    const cBits = fk.X.map((Xi, i) => {
        const shared = J.mulPointEscalar(Xi, rMod);
        return sharedBit(J, Rpacked, i, shared) ^ 1;
    });

    return { R: Rpacked, bits: packBits(cBits), gamma };
}

export function fmdTest(J: Jubjub, dk: FmdDetectionKey, clue: FmdClue): boolean {
    if (dk.x.length !== clue.gamma) return false;
    if (J instanceof WasmJubjub) {
        const dkLe = new Uint8Array(clue.gamma * FIELD_BYTES);
        for (let i = 0; i < clue.gamma; i++) {
            dkLe.set(toLeBytes(dk.x[i] % BABYJUB_SUBGROUP_ORDER, FIELD_BYTES), i * FIELD_BYTES);
        }
        return J.fmdTest(dkLe, clue.R, clue.bits, clue.gamma);
    }
    const R = J.unpackPoint(clue.R);
    if (!R || !J.inSubgroup(R)) return false;

    const cBits = unpackBits(clue.bits, clue.gamma);
    for (let i = 0; i < clue.gamma; i++) {
        const shared = J.mulPointEscalar(R, dk.x[i]);
        if ((sharedBit(J, clue.R, i, shared) ^ cBits[i]) !== 1) return false;
    }
    return true;
}

export function encodeClue(c: FmdClue): Uint8Array {
    const out = new Uint8Array(1 + 32 + c.bits.length);
    out[0] = c.gamma;
    out.set(c.R, 1);
    out.set(c.bits, 33);
    return out;
}

export function decodeClue(buf: Uint8Array): FmdClue {
    const gamma = buf[0];
    return {
        gamma,
        R: buf.slice(1, 33),
        bits: buf.slice(33, 33 + Math.ceil(gamma / 8)),
    };
}

// ---- internals ----

// Domain-separated bit extracted from H(domain, R, i, sharedPoint).
function sharedBit(J: Jubjub, R: Uint8Array, i: number, shared: Point): number {
    const h = blake2b.create({ dkLen: 32 });
    h.update(FMD_DOMAIN);
    h.update(R);
    h.update(u32LE(i));
    h.update(J.packPoint(shared));
    return h.digest()[0] & 1;
}

function u32LE(n: number): Uint8Array {
    const out = new Uint8Array(4);
    new DataView(out.buffer).setUint32(0, n, true);
    return out;
}

function packBits(bits: number[]): Uint8Array {
    const out = new Uint8Array(Math.ceil(bits.length / 8));
    for (let i = 0; i < bits.length; i++) {
        if (bits[i]) out[i >> 3] |= 1 << (i & 7);
    }
    return out;
}

function unpackBits(buf: Uint8Array, gamma: number): number[] {
    const out: number[] = new Array(gamma);
    for (let i = 0; i < gamma; i++) out[i] = (buf[i >> 3] >> (i & 7)) & 1;
    return out;
}
