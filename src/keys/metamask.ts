// EthSigner → nsk derivation: EIP-712 typed-data sign over a fixed,
// version-stamped domain → keccak256 → reduce mod Baby-Jubjub subgroup order.
//
// IMPORTANT: domain MUST NEVER be reused across versions. Bumping
// `LELANTOS_NSK_DOMAIN.version` invalidates all derived keys.

import { hashTypedData, keccak256, type TypedDataDomain, type TypedDataParameter } from "viem";
import { BABYJUB_SUBGROUP_ORDER } from "../core/field.js";
import type { EthSigner } from "../core/signer.js";
import type { Field } from "../crypto/poseidon.js";

export const LELANTOS_NSK_DOMAIN: TypedDataDomain = {
    name: "Lelantos",
    version: "1",
    // chainId omitted on purpose — nsk is chain-independent.
};

const TYPES: Record<string, TypedDataParameter[]> = {
    LelantosKeyDerivation: [
        { name: "purpose", type: "string" },
        { name: "version", type: "string" },
    ],
};

const PRIMARY_TYPE = "LelantosKeyDerivation";

const MESSAGE = {
    purpose: "nsk-derivation",
    version: "1",
} as const;

// Returns nsk ∈ [1, BABYJUB_SUBGROUP_ORDER). Caller must persist this
// securely — losing nsk = losing all spend authority for the address.
export async function deriveNskFromSigner(signer: EthSigner): Promise<Field> {
    const sig = await signer.signTypedData(LELANTOS_NSK_DOMAIN, TYPES, PRIMARY_TYPE, MESSAGE);
    return reduceSignatureToScalar(sig);
}

export function reduceSignatureToScalar(sigHex: string): Field {
    const digest = keccak256(sigHex as `0x${string}`);
    const x = BigInt(digest);
    const r = x % BABYJUB_SUBGROUP_ORDER;
    return r === 0n ? 1n : r;
}

/** Recompute the typed-data hash without a signer (tests / verification). */
export function lelantosTypedDataHash(): string {
    return hashTypedData({
        domain: LELANTOS_NSK_DOMAIN,
        types: TYPES as any,
        primaryType: PRIMARY_TYPE,
        message: MESSAGE,
    });
}
