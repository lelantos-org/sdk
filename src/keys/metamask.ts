// MetaMask → nsk derivation: EIP-712 typed-data sign over a fixed,
// version-stamped domain → keccak256 → reduce mod Baby-Jubjub subgroup order.
//
// IMPORTANT: domain MUST NEVER be reused across versions. Bumping
// `LELANTOS_NSK_DOMAIN.version` invalidates all derived keys.

import { keccak256, type Signer, TypedDataEncoder, type TypedDataField } from "ethers";
import { BABYJUB_SUBGROUP_ORDER, type Field } from "../crypto/index.js";

export const LELANTOS_NSK_DOMAIN = {
    name: "Lelantos",
    version: "1",
    // chainId omitted on purpose — nsk is chain-independent.
} as const;

const TYPES: Record<string, TypedDataField[]> = {
    LelantosKeyDerivation: [
        { name: "purpose", type: "string" },
        { name: "version", type: "string" },
    ],
};

const MESSAGE = {
    purpose: "nsk-derivation",
    version: "1",
} as const;

// Returns nsk ∈ [1, BABYJUB_SUBGROUP_ORDER). Caller must persist this
// securely — losing nsk = losing all spend authority for the address.
export async function deriveNskFromSigner(signer: Signer): Promise<Field> {
    const sig = await signer.signTypedData(LELANTOS_NSK_DOMAIN, TYPES, MESSAGE);
    return reduceSignatureToScalar(sig);
}

export function reduceSignatureToScalar(sigHex: string): Field {
    const digest = keccak256(sigHex);
    const x = BigInt(digest);
    const r = x % BABYJUB_SUBGROUP_ORDER;
    return r === 0n ? 1n : r;
}

/// Offline variant: reduce a precomputed signature/digest.
export function nskFromTypedDataDigest(typedDataDigest: string): Field {
    return reduceSignatureToScalar(typedDataDigest);
}

/// Recompute the typed-data hash without a signer (tests / verification).
export function lelantosTypedDataHash(): string {
    return TypedDataEncoder.hash(LELANTOS_NSK_DOMAIN, TYPES, MESSAGE);
}
