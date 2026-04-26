// MetaMask → nsk derivation. EIP-712 typed-data sign over a fixed,
// version-stamped domain → keccak256 → reduce mod Baby-Jubjub subgroup
// order. Pattern is the same one Aztec / Railgun / Penumbra wallet
// adapters use; do not roll your own.
//
// IMPORTANT: domain must NEVER be reused across versions. Bumping
// `LELANTOS_NSK_DOMAIN.version` invalidates all derived keys, which is
// exactly what you want if the derivation pipeline changes.

import { keccak256, TypedDataEncoder, type Signer } from "ethers";
import { BABYJUB_SUBGROUP_ORDER, type Field } from "./crypto/index";

export const LELANTOS_NSK_DOMAIN = {
    name: "Lelantos",
    version: "1",
    // chainId omitted on purpose — nsk is chain-independent.
} as const;

const TYPES = {
    LelantosKeyDerivation: [
        { name: "purpose", type: "string" },
        { name: "version", type: "string" },
    ],
} as const;

const MESSAGE = {
    purpose: "nsk-derivation",
    version: "1",
} as const;

// Returns nsk ∈ [1, BABYJUB_SUBGROUP_ORDER). Caller must persist this
// securely — losing nsk = losing all spend authority for the address.
export async function deriveNskFromSigner(signer: Signer): Promise<Field> {
    const sig = await signer.signTypedData(LELANTOS_NSK_DOMAIN, TYPES as any, MESSAGE);
    return reduceSignatureToScalar(sig);
}

export function reduceSignatureToScalar(sigHex: string): Field {
    const digest = keccak256(sigHex);
    const x = BigInt(digest);
    const r = x % BABYJUB_SUBGROUP_ORDER;
    return r === 0n ? 1n : r;
}

// Off-line variant: hash a precomputed signature (e.g. from a hardware
// wallet flow that already returned the bytes).
export function nskFromTypedDataDigest(typedDataDigest: string): Field {
    return reduceSignatureToScalar(typedDataDigest);
}

// Helper for tests / unit verification — recompute the typed-data hash
// without going through a signer.
export function lelantosTypedDataHash(): string {
    return TypedDataEncoder.hash(LELANTOS_NSK_DOMAIN, TYPES as any, MESSAGE);
}
