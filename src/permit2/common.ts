// What every Permit2 signature shares: the EIP-712 domain and the prompt.

import type { TypedDataDomain } from "viem";
import { asUserRejection } from "../errors/chain.js";
import { PERMIT2_ADDRESS } from "../protocol/deposit-request.js";

/**
 * The EIP-712 domain every Permit2 signature is bound to.
 *
 * Shared by every signature family (`./witness.ts`, `./allowance.ts`) so a non-canonical deployment
 * or domain-field change applies to each consistently.
 */
export function permit2Domain(chainId: bigint, permit2Address?: string): TypedDataDomain {
    return {
        name: "Permit2",
        chainId,
        verifyingContract: (permit2Address ?? PERMIT2_ADDRESS) as `0x${string}`,
    };
}

/** Run a permit signature prompt, reporting a declined prompt as `USER_REJECTED`. */
export async function signPermit(sign: () => Promise<string>): Promise<string> {
    try {
        return await sign();
    } catch (err) {
        throw asUserRejection(err, "sign-permit");
    }
}
