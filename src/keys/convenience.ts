// Context-free wrappers over the key and FMD primitives.
//
// The primitives take explicit `Poseidon` / `Jubjub` instances because the
// worker and benchmark paths supply their own. Application code has no reason
// to know those types exist, so these wrappers resolve the shared context
// (`cryptoContext`) and are what the root barrel exports.

import { cryptoContext } from "../crypto/context.js";
import type { FmdDetectionKey } from "../fmd/fmd.js";
import { FMD_DEFAULT_GAMMA } from "../fmd/fmd.js";
import { type DecodedAddress, decodeAddress } from "./address.js";
import { detectionKeyFor, type ViewingKey } from "./keys.js";

/**
 * Parse and validate a bech32m shielded address.
 *
 * ```ts
 * const { pk_d, pk, ck } = await parseAddress(peerBech32);
 * ```
 */
export async function parseAddress(addr: string): Promise<DecodedAddress> {
    const { J } = await cryptoContext();
    return decodeAddress(J, addr);
}

/**
 * The γ FMD detection scalars for a viewing key.
 *
 * Releasing these releases the root detection secret permanently — see
 * `detectionKeyFor`.
 */
export async function detectionKey(
    vk: ViewingKey,
    gamma: number = FMD_DEFAULT_GAMMA,
): Promise<FmdDetectionKey> {
    const { P, J } = await cryptoContext();
    return detectionKeyFor(J, P, vk, gamma);
}
