// EIP-712 typed-data shapes and a narrow encoder for them.
//
// The types match viem's of the same name structurally; `chain/signer/` passes
// them to `signTypedData`. Declaring them here keeps viem out of `core/` and
// `keys/`, in source and in emitted declarations. viem is an optional peer.

/** EIP-712 domain separator fields. Every member is optional per the spec. */
export interface TypedDataDomain {
    /** `bigint` as well as `number`: abitype accepts both, and so must this. */
    chainId?: number | bigint | undefined;
    name?: string | undefined;
    salt?: `0x${string}` | undefined;
    verifyingContract?: `0x${string}` | undefined;
    version?: string | undefined;
}

/** One member of a typed-data struct. */
export interface TypedDataParameter {
    name: string;
    type: string;
}

// --- Encoding ------------------------------------------------------------
//
// Structs whose every member is a `string`. `encodeData` is then a
// concatenation of 32-byte words: `keccak(typeString)`, then `keccak(utf8(v))`
// per member. Dynamic arrays, nested structs and numeric members are not
// supported; `chain/` uses viem for those.

import { keccak_256 } from "@noble/hashes/sha3";
import { branded, type Hex32 } from "./brand.js";
import { bytesToHex } from "./hex.js";

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

/**
 * `hashStruct` for an all-`string` struct:
 * `keccak256(keccak(typeString) || keccak(v)...)`.
 *
 * Also produces the domain separator. The type string must list exactly the
 * members present.
 */
export function hashStringStruct(typeString: string, values: readonly string[]): Uint8Array {
    const words = [typeString, ...values].map((v) => keccak_256(utf8(v)));
    const out = new Uint8Array(words.length * 32);
    for (const [i, w] of words.entries()) out.set(w, i * 32);
    return keccak_256(out);
}

/** The signed digest: `keccak256(0x19 0x01 || domainSeparator || structHash)`. */
export function typedDataDigest(domainSeparator: Uint8Array, structHash: Uint8Array): Hex32 {
    const preimage = new Uint8Array(2 + 32 + 32);
    preimage[0] = 0x19;
    preimage[1] = 0x01;
    preimage.set(domainSeparator, 2);
    preimage.set(structHash, 2 + 32);
    return branded<Hex32>(bytesToHex(keccak_256(preimage)));
}
