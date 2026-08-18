// EthSigner → nsk derivation: EIP-712 typed-data sign over a fixed,
// version-stamped domain → keccak256 → reduce mod Baby-Jubjub subgroup order.
//
// IMPORTANT: domain MUST NEVER be reused across versions. Bumping
// `LELANTOS_NSK_DOMAIN.version` invalidates all derived keys.

import { hashTypedData, type TypedDataDomain, type TypedDataParameter } from "viem";
import { InvalidArgumentError } from "../core/errors.js";
import { BABYJUB_SUBGROUP_ORDER } from "../core/field.js";
import { keccak256 } from "../core/keccak.js";
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

/** secp256k1 group order; `s` above half of it has an equivalent low form. */
const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const SECP256K1_HALF_N = SECP256K1_N >> 1n;

/**
 * `nsk` from an EIP-712 signature, over a canonical form of that signature.
 *
 * Canonicalisation matters because a wallet's whole identity hangs off this.
 * ECDSA admits more than one valid encoding of the same signature over the
 * same digest:
 *
 *   - `v` is written as 27/28 by some wallets and 0/1 by others;
 *   - `(r, s)` and `(r, n - s)` are both valid, and only some signers
 *     normalise to the low half.
 *
 * Hashing the raw 65 bytes therefore derived a *different* `nsk` — a different
 * address, and no access to the funds at the old one — from wallet software
 * that merely encoded the same signature differently. So `v` is dropped and
 * `s` is folded into its low form before hashing.
 *
 * **This changes derived keys.** Any address derived by an earlier version
 * from a signature will not be reproduced here. That is the point — the old
 * derivation was not stable — and it is why this belongs before a deployment
 * rather than after one. The mnemonic and private-key sources are unaffected.
 */
export function reduceSignatureToScalar(sigHex: string): Field {
    const digest = keccak256(canonicalSignature(sigHex));
    const x = BigInt(digest);
    const r = x % BABYJUB_SUBGROUP_ORDER;
    return r === 0n ? 1n : r;
}

/** `r || lowS` as 64 bytes of hex. Rejects anything that is not a signature. */
function canonicalSignature(sigHex: string): `0x${string}` {
    const body = sigHex.startsWith("0x") || sigHex.startsWith("0X") ? sigHex.slice(2) : sigHex;
    // 65 bytes exactly: r(32) || s(32) || v(1). The previous length check
    // accepted any even-length hex, so a truncated signature derived a wallet
    // instead of failing.
    if (!/^[0-9a-fA-F]{130}$/.test(body)) {
        throw new InvalidArgumentError(
            `signature must be 65 bytes of hex (r || s || v); got ${body.length / 2} bytes`,
            { argument: "signature" },
        );
    }
    const r = body.slice(0, 64);
    const s = BigInt(`0x${body.slice(64, 128)}`);
    if (s === 0n || s >= SECP256K1_N) {
        throw new InvalidArgumentError("signature `s` is outside the secp256k1 group", {
            argument: "signature",
        });
    }
    const lowS = s > SECP256K1_HALF_N ? SECP256K1_N - s : s;
    return `0x${r}${lowS.toString(16).padStart(64, "0")}`;
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
