// EIP-712 payload serialisation for `eth_signTypedData_v4`.
//
// Only `Eip1193Signer` needs these: a raw provider wants JSON with an
// explicit EIP712Domain type and hex-encoded bigints, whereas viem's
// local-account signer takes the structured values directly.

import type { TypedDataDomain } from "viem";
import { bigintToHex } from "../../core/hex.js";

export function domainTypes(domain: TypedDataDomain) {
    const out: { name: string; type: string }[] = [];
    if (domain.name !== undefined) out.push({ name: "name", type: "string" });
    if (domain.version !== undefined) out.push({ name: "version", type: "string" });
    if (domain.chainId !== undefined) out.push({ name: "chainId", type: "uint256" });
    if (domain.verifyingContract !== undefined) {
        out.push({ name: "verifyingContract", type: "address" });
    }
    if (domain.salt !== undefined) out.push({ name: "salt", type: "bytes32" });
    return out;
}

export function serialisableDomain(domain: TypedDataDomain): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    if (domain.name !== undefined) out.name = domain.name;
    if (domain.version !== undefined) out.version = domain.version;
    if (domain.chainId !== undefined) out.chainId = bigintToHex(BigInt(domain.chainId));
    if (domain.verifyingContract !== undefined) out.verifyingContract = domain.verifyingContract;
    if (domain.salt !== undefined) out.salt = domain.salt;
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
