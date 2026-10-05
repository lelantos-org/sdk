// The key that controls an account's handle in `LelantosNameRegistrar`.
//
//   k = blake2b-256( "lelantos.name.controller.v1" || LE32(nsk) || counter )   first k in [1, n)
//
// A secp256k1 key, because the registrar authorizes `setValue` by an EIP-712 signature it checks
// with `ecrecover`. Derived from `nsk` under its own domain tag, so it reveals nothing about the
// spending key and is the same on every device. Its address is public (it is the handle's
// `controller`); nothing else links it to the account or to the user's EVM account.
//
// The counter is zero except with probability about 2^-128, when a digest falls outside the
// scalar range.

import { blake2b } from "@noble/hashes/blake2";
import { privateKeyToAddress } from "viem/accounts";
import { branded, type EvmAddress, type Hex32 } from "../core/brand.js";
import { toLeBytes } from "../core/bytes.js";
import { assertField, type Field } from "../core/field.js";
import { bytesToHex } from "../core/hex.js";
import { InternalError } from "../errors/base.js";

const DOMAIN = new TextEncoder().encode("lelantos.name.controller.v1");

/** Order of the secp256k1 group. */
const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

/** A handle's controller key. The private key signs `setValue`; the address is public. */
export interface NameControllerKey {
    /** secp256k1 private key, 0x-hex. Whoever holds it can change or clear the handle's value. */
    privateKey: Hex32;
    address: EvmAddress;
}

/**
 * The controller key of the account whose spending secret is `nsk`.
 *
 * @throws {InvalidArgumentError} when `nsk` is not a canonical field element.
 */
export function deriveNameControllerKey(nsk: Field): NameControllerKey {
    assertField(nsk, "nsk");
    const secret = toLeBytes(nsk);
    for (let counter = 0; counter < 256; counter++) {
        const h = blake2b.create({ dkLen: 32 });
        h.update(DOMAIN);
        h.update(secret);
        h.update(Uint8Array.of(counter));
        const privateKey = bytesToHex(h.digest());
        const k = BigInt(privateKey);
        if (k !== 0n && k < SECP256K1_N) {
            return {
                privateKey: branded<Hex32>(privateKey),
                address: branded<EvmAddress>(privateKeyToAddress(privateKey as `0x${string}`)),
            };
        }
    }
    throw new InternalError("no name controller key in 256 attempts");
}
