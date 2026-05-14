// Public type aliases. Not nominal brands — assignment from `string` works.
// Validators (`parseHex`, `parseEthAddress`, `parseUrl`) provide runtime
// checks at trust boundaries.

/// 0x-prefixed lower-hex string. SDK uses these for note commitments,
/// nullifiers, and transaction hashes (32 bytes → 66 chars total).
export type Hex = string;

/// 0x-prefixed checksummed Ethereum address (20 bytes → 42 chars total).
/// Validated lazily — accept any 0x… string in inputs.
export type EthAddress = string;

/// Bech32m-encoded shielded address (`lelantos2…`). Decoded via
/// `decodeAddress` from `./address.js`.
export type ShieldedAddress = string;

/// HTTP(S) base URL. SDK clients accept either a `URL` instance or a string;
/// see `parseUrl` if you want a runtime guard.
export type Url = string | URL;

const HEX_RE = /^0x[0-9a-fA-F]+$/;

/// Validate that a string is 0x-prefixed hex of exactly `bytes` bytes
/// (default: any length). Returns the lowercased value or throws.
export function parseHex(input: string, bytes?: number): Hex {
    if (!HEX_RE.test(input)) {
        throw new TypeError(`expected 0x-hex string, got ${JSON.stringify(input)}`);
    }
    if (bytes !== undefined && input.length !== 2 + bytes * 2) {
        throw new TypeError(`expected ${bytes}-byte 0x-hex, got ${input.length - 2} hex chars`);
    }
    return input.toLowerCase();
}

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

/// Validate that a string is a 20-byte 0x-prefixed Ethereum address.
/// Does NOT check EIP-55 checksum casing.
export function parseEthAddress(input: string): EthAddress {
    if (!ADDR_RE.test(input)) {
        throw new TypeError(`expected 0x-prefixed 20-byte address, got ${JSON.stringify(input)}`);
    }
    return input.toLowerCase();
}

/// Coerce string|URL to a URL instance (throws on malformed input).
export function parseUrl(input: Url): URL {
    if (input instanceof URL) return input;
    try {
        return new URL(input);
    } catch {
        throw new TypeError(`expected valid URL, got ${JSON.stringify(input)}`);
    }
}

/// Snarkjs Groth16 artifacts: WASM witness calculator + final zkey. Either
/// filesystem path (Node) or fetchable URL (browser); SDK auto-detects.
export interface ProverArtifacts {
    /// `<circuit>.wasm` — circom-generated witness calculator.
    circuit: Url;
    /// `<circuit>_final.zkey` — phase-2 contribution output.
    zkey: Url;
}

/// Stringify a `Url` for snarkjs (which accepts either path or URL string).
export function urlToString(u: Url): string {
    return u instanceof URL ? u.href : u;
}
