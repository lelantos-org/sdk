// EIP-712 payload serialisation for `eth_signTypedData_v4`.
//
// Only `Eip1193Signer` needs these: a raw provider wants JSON with an
// explicit EIP712Domain type and hex-encoded bigints, whereas viem's
// local-account signer takes the structured values directly.

import type { TypedDataDomain } from "viem";
import { bigintToHex } from "../../core/hex.js";

/** `EIP712Domain` fields in the order EIP-712 declares them, which fixes the separator's encoding. */
const DOMAIN_FIELDS = [
    ["name", "string"],
    ["version", "string"],
    ["chainId", "uint256"],
    ["verifyingContract", "address"],
    ["salt", "bytes32"],
] as const;

/** The `EIP712Domain` type entries for the fields `domain` sets. */
export function domainTypes(domain: TypedDataDomain) {
    return DOMAIN_FIELDS.filter(([name]) => domain[name] !== undefined).map(([name, type]) => ({
        name,
        type,
    }));
}

/** `domain` as JSON-safe values, in the order {@link domainTypes} declares them. */
export function serialisableDomain(domain: TypedDataDomain): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [name] of DOMAIN_FIELDS) {
        const value = domain[name];
        if (value === undefined) continue;
        out[name] = name === "chainId" ? bigintToHex(BigInt(value)) : value;
    }
    return out;
}

export function stringifyBigInts(v: unknown): unknown {
    if (typeof v === "bigint") return bigintToHex(v);
    if (Array.isArray(v)) return v.map(stringifyBigInts);
    if (v && typeof v === "object") {
        const out: Record<string, unknown> = {};
        for (const [k, val] of Object.entries(v)) out[k] = stringifyBigInts(val);
        return out;
    }
    return v;
}
