// Wire-format helpers shared across the relayer codec, permit2 signer,
// and the chain adapter. All three previously inlined identical
// `bytesToHex` / `hexToBytes` pairs.

/// `0x`-prefixed lowercase hex of a byte array.
export function bytesToHex(b: Uint8Array): string {
    let h = "0x";
    for (const x of b) h += x.toString(16).padStart(2, "0");
    return h;
}

/// Decode an optionally-`0x`-prefixed even-length hex string. Throws on
/// non-hex input via `parseInt(NaN)` propagation; callers validate format
/// upstream where useful (`utils/types.ts → parseHex`).
export function hexToBytes(h: string): Uint8Array {
    const s = h.startsWith("0x") ? h.slice(2) : h;
    const out = new Uint8Array(s.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(2 * i, 2 * i + 2), 16);
    return out;
}
