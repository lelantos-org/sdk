// Deterministic throwaway EVM keys for the unshielded x402 mechanism.
//
// Paying a standard `exact` server means holding ERC-20 at an EVM address.
// Using the wallet's own signer address would link every API call to it, so
// each payer address is derived from `nsk` instead: unlinkable to the
// operator's account, and recoverable from the same seed on any machine.
//
// Derivation mirrors `hexPrivateKeyToNsk` in `../keys/key-source.ts` — a
// domain-tagged keccak — so it works from any `KeySource` (mnemonic, EIP-712
// signature, raw nsk), not just mnemonics. Deriving from nsk also makes these
// keys exactly as sensitive as the shielded wallet: whoever holds nsk holds
// them.

import { toLeBytes } from "../core/bytes.js";
import { InvalidArgumentError } from "../core/errors.js";
import type { Field } from "../core/field.js";
import { bytesToBareHex } from "../core/hex.js";
import { keccak256 } from "../core/keccak.js";

/**
 * ASCII bytes of `"lelantos.x402.eph\0"`. Bumping this invalidates every
 * address derived from this path — any ERC-20 already sitting at one becomes
 * unreachable through the SDK. Do not change without a migration.
 */
const EPH_DOMAIN_TAG_HEX = "6c656c616e746f732e783430322e65706800";

/** Order of the secp256k1 group. A valid private key is in `[1, n-1]`. */
const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

/** Exclusive upper bound for `index`, matching the ZIP-32 account bound. */
const MAX_INDEX = 0x80000000;

/**
 * `keccak256(domainTag ‖ nsk_le ‖ u32le(index))` reduced into `[1, n-1]`.
 *
 * Deterministic: the same wallet and index always yield the same key, so a
 * top-up sent to `index` is still spendable after a restart.
 *
 * @param nsk Nullifier spending key — `wallet.keys.nsk`.
 * @param index Payer slot. Distinct indices are unlinkable to each other.
 */
export function deriveEphemeralKey(nsk: Field, index: number): `0x${string}` {
    if (!Number.isInteger(index) || index < 0 || index >= MAX_INDEX) {
        throw new InvalidArgumentError(
            `x402 ephemeral index must be an integer in [0, 2^31); got ${index}`,
            { argument: "index" },
        );
    }
    const digest = keccak256(
        `0x${EPH_DOMAIN_TAG_HEX}${bytesToBareHex(toLeBytes(nsk))}${u32LeHex(index)}` as const,
    );
    // Map into [1, n-1]: `% (n-1)` lands in [0, n-2], so shift by one. The
    // modulo bias is ~2^-128 and irrelevant for a 256-bit group.
    const scalar = (BigInt(digest) % (SECP256K1_N - 1n)) + 1n;
    return `0x${scalar.toString(16).padStart(64, "0")}`;
}

function u32LeHex(n: number): string {
    const b = new Uint8Array(4);
    b[0] = n & 0xff;
    b[1] = (n >>> 8) & 0xff;
    b[2] = (n >>> 16) & 0xff;
    b[3] = (n >>> 24) & 0xff;
    return bytesToBareHex(b);
}
