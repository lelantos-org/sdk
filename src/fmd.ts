// Fuzzy Message Detection — FMD2 (Beck & Len, 2021), a.k.a. Niwl.
//
// Scheme variant: lelantos.fmd.v3 (poseidon + Legendre symbol).
// v2 used `lsb1(Poseidon(...))` for bit derivation. v3 swaps to the
// Legendre symbol of the Poseidon output: bit = 1 iff the hash is a
// quadratic residue in 𝔽_r. This cuts the in-circuit cost from
// ~254 constraints/γ (Num2Bits) to ~4 (HashToBit gadget) while
// preserving uniform-bit security under Poseidon-as-RO. Old v2 detection
// keys produce different bits and are NOT interoperable with v3.
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
//   for i ∈ [γ]: bit_i = legendre_bit(Poseidon([TAG_FMD_BIT, R.x, R.y, i, S_i.x, S_i.y]))
//                S_i = r·X_i
//                c_i = bit_i ⊕ 1
//   clue = (R, c_1 || ... || c_γ)
//   where legendre_bit(h) = 1 iff h is a quadratic residue in 𝔽_r.
//
// Receiver tests with dk:
//   S_i = x_i · R
//   for i ∈ [γ]: bit_i = legendre_bit(Poseidon([TAG_FMD_BIT, R.x, R.y, i, S_i.x, S_i.y]))
//                if bit_i ⊕ c_i ≠ 1 → reject
//
// Honest recipient: r·X_i == x_i·R, so all γ checks pass.
// Anyone else: each check independent random ⇒ accept with prob 2^-γ.
//
// Wire format:
//   encoded clue = γ (1B) || R_packed (32B) || c_bits (⌈γ/8⌉ B, LSB-first)
//
// Byte order locked against the Rust indexer impl via deterministic vectors.
// Bumping FMD_DOMAIN signals scheme change.

import {
    BABYJUB_SUBGROUP_ORDER,
    BN254_FR,
    FIELD_BYTES,
    type Field,
    type Jubjub,
    legendreSymbol,
    type Point,
    toLeBytes,
} from "./crypto/index.js";
import type { Poseidon } from "./crypto/poseidon.js";

export const FMD_DEFAULT_GAMMA = 5;
export const FMD_DOMAIN = "lelantos.fmd.v3";
/// Domain-separation tag for FMD bit derivation. Mirrors `TAG_FMD_BIT` in
/// circuits/src/lib/tags.circom and `TAG_FMD_BIT` in
/// backend/crates/fmd-crypto/src/clue.rs. Must NOT collide with other tags.
export const TAG_FMD_BIT: bigint = 8n;

export interface FmdDetectionKey {
    x: Field[];
}
export interface FmdFlagKey {
    X: Point[];
}
export interface FmdClue {
    R: Uint8Array;
    bits: Uint8Array;
    gamma: number;
}

/// Encode a `FmdDetectionKey` as the `γ * 32`-byte little-endian blob the
/// fmd-webserver subscription endpoint expects. Each scalar is reduced
/// mod `BABYJUB_SUBGROUP_ORDER` then serialized LE-32. Matches the
/// `Buffer::concat` over `to_le_bytes()` encoding on the rust side.
export function detectionKeyToBytes(dk: FmdDetectionKey): Uint8Array {
    const out = new Uint8Array(dk.x.length * FIELD_BYTES);
    for (let i = 0; i < dk.x.length; i++) {
        out.set(toLeBytes(dk.x[i] % BABYJUB_SUBGROUP_ORDER, FIELD_BYTES), i * FIELD_BYTES);
    }
    return out;
}

/// Hex-encode a detection key for transport (no `0x` prefix — that's what
/// the server expects on `POST /v1/subscriptions`).
export function detectionKeyToHex(dk: FmdDetectionKey): string {
    const b = detectionKeyToBytes(dk);
    let h = "";
    for (const x of b) h += x.toString(16).padStart(2, "0");
    return h;
}

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
    return { X: dk.x.map((xi) => J.mulPointEscalar(J.base8, xi)) };
}

export function fmdFlag(J: Jubjub, P: Poseidon, fk: FmdFlagKey, r: Field): FmdClue {
    const gamma = fk.X.length;
    const rMod = r % BABYJUB_SUBGROUP_ORDER;
    if (rMod === 0n) throw new Error("fmd flag: r must be non-zero mod q");

    const R = J.mulPointEscalar(J.base8, rMod);
    const Rpacked = J.packPoint(R);

    const cBits = fk.X.map((Xi, i) => {
        const shared = J.mulPointEscalar(Xi, rMod);
        return sharedBit(P, R, i, shared) ^ 1;
    });

    return { R: Rpacked, bits: packBits(cBits), gamma };
}

export function fmdTest(J: Jubjub, P: Poseidon, dk: FmdDetectionKey, clue: FmdClue): boolean {
    if (dk.x.length !== clue.gamma) return false;
    const R = J.unpackPoint(clue.R);
    if (!R || !J.inSubgroup(R)) return false;

    const cBits = unpackBits(clue.bits, clue.gamma);
    for (let i = 0; i < clue.gamma; i++) {
        const shared = J.mulPointEscalar(R, dk.x[i]);
        if ((sharedBit(P, R, i, shared) ^ cBits[i]) !== 1) return false;
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

// Legendre-symbol bit of Poseidon([TAG_FMD_BIT, R.x, R.y, i, S.x, S.y]).
// Same six-input layout as the in-circuit `ClueCheck` (bit=1 ⟺ QR).
function sharedBit(P: Poseidon, R: Point, i: number, shared: Point): number {
    const h = P.hash([TAG_FMD_BIT, R[0], R[1], BigInt(i), shared[0], shared[1]]);
    const sym = legendreSymbol(h, BN254_FR);
    if (sym === 0) throw new Error("FMD shared bit: hash collided to zero");
    return sym === 1 ? 1 : 0;
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
