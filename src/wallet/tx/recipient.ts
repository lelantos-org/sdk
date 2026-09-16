// A shielded `recipient` argument, checked and decoded before any I/O.

import { type ShieldedAddress, shieldedAddress } from "../../core/brand.js";
import type { Jubjub } from "../../crypto/index.js";
import { InvalidArgumentError } from "../../errors/config.js";
import { type DecodedAddress, decodeAddress } from "../../keys/address.js";

/**
 * `recipient` decoded, and in its canonical lowercase spelling (bech32m also permits uppercase).
 *
 * @throws {InvalidArgumentError} when it is not a string or not a shielded address.
 */
export function shieldedRecipient(
    J: Jubjub,
    recipient: unknown,
    op: string,
): { address: ShieldedAddress; decoded: DecodedAddress } {
    if (typeof recipient !== "string") {
        throw new InvalidArgumentError(`${op}: recipient must be a shielded address`, {
            argument: "recipient",
        });
    }
    const decoded = decodeAddress(J, recipient);
    return { address: shieldedAddress(recipient.toLowerCase()), decoded };
}
