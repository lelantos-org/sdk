// Wire-format helpers shared by the relayer codec, permit2 signer, and
// chain adapter.

/// `0x`-prefixed lowercase hex of a byte array.
export function bytesToHex(b: Uint8Array): string {
    let h = "0x";
    for (const x of b) h += x.toString(16).padStart(2, "0");
    return h;
}

/// Decode an optionally-`0x`-prefixed even-length hex string. Input is not
/// validated here; callers validate upstream (`utils/types.ts → parseHex`).
export function hexToBytes(h: string): Uint8Array {
    const s = h.startsWith("0x") ? h.slice(2) : h;
    const out = new Uint8Array(s.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(2 * i, 2 * i + 2), 16);
    return out;
}
