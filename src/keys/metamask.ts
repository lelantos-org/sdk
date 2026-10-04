// EthSigner → nsk derivation: EIP-712 typed-data signature over a fixed, version-stamped domain,
// hashed with keccak and reduced mod the Baby-Jubjub subgroup order.
//
// `LELANTOS_NSK_DOMAIN.version` denotes the reduction: a different reduction must use a different
// version, and changing the version changes every derived key.

import { BABYJUB_SUBGROUP_ORDER, reduceWideToField, SECP256K1_N } from "../core/field.js";
import { hexToBytes, strip0x } from "../core/hex.js";
import {
    hashStringStruct,
    type TypedDataDomain,
    type TypedDataParameter,
    typedDataDigest,
} from "../crypto/eip712.js";
import { keccakExpand } from "../crypto/keccak.js";
import type { Field } from "../crypto/poseidon.js";
import { asUserRejection } from "../errors/chain.js";
import { InvalidArgumentError } from "../errors/config.js";
import type { EthSigner } from "./signer.js";

export const LELANTOS_NSK_DOMAIN: TypedDataDomain = {
    name: "Lelantos",
    // "1" denotes the two-keccak-block reduction below, so each reduction signs a distinct message.
    version: "1",
    // chainId omitted: nsk is chain-independent.
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

// Returns nsk ∈ [1, BABYJUB_SUBGROUP_ORDER). The caller must persist it securely: losing nsk
// loses all spend authority for the address.
export async function deriveNskFromSigner(signer: EthSigner): Promise<Field> {
    let sig: string;
    try {
        sig = await signer.signTypedData(LELANTOS_NSK_DOMAIN, TYPES, PRIMARY_TYPE, MESSAGE);
    } catch (err) {
        // A declined prompt is reported as a user rejection, not a signer failure.
        throw asUserRejection(err, "derive-key");
    }
    return reduceSignatureToScalar(sig);
}

/** `s` above half the secp256k1 group order has an equivalent low form. */
const SECP256K1_HALF_N = SECP256K1_N >> 1n;

/**
 * `nsk` from an EIP-712 signature, computed over a canonical form of that signature.
 *
 * ECDSA admits several valid encodings of the same signature over the same digest: `v` is 27/28
 * or 0/1 depending on the wallet, and `(r, s)` and `(r, n - s)` are both valid. `v` is dropped and
 * `s` folded into its low form before hashing, so every encoding derives the same `nsk` and
 * address.
 *
 * Two keccak blocks, not one: a bare 256-bit digest leaves 5 spare bits over the 251-bit subgroup
 * order, which biases the result. See `reduceWideToField`.
 */
export function reduceSignatureToScalar(sigHex: string): Field {
    const canonical = hexToBytes(canonicalSignature(sigHex));
    return reduceWideToField(keccakExpand(canonical, 2), BABYJUB_SUBGROUP_ORDER, "nsk");
}

/** `r || lowS` as 64 bytes of hex. Rejects anything that is not a signature. */
function canonicalSignature(sigHex: string): `0x${string}` {
    const body = strip0x(sigHex);
    // Exactly 65 bytes: r(32) || s(32) || v(1). A truncated signature must fail rather than
    // derive a wallet.
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

/**
 * The digest a wallet signs, recomputed without a signer.
 *
 * Encoded by `crypto/eip712.ts`, which supports only all-`string` structs, so `keys/` has no
 * runtime dependency on viem. `encoding-parity.test.ts` pins the result against an independent
 * implementation: any drift derives a different `nsk` from the same wallet.
 */
export function lelantosTypedDataHash(): string {
    return typedDataDigest(
        hashStringStruct("EIP712Domain(string name,string version)", [
            LELANTOS_NSK_DOMAIN.name as string,
            LELANTOS_NSK_DOMAIN.version as string,
        ]),
        hashStringStruct(`${PRIMARY_TYPE}(string purpose,string version)`, [
            MESSAGE.purpose,
            MESSAGE.version,
        ]),
    );
}
