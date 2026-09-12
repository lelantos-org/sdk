// WebAuthn PRF → nsk.
//
// The split of responsibility mirrors `metamask.ts`: this module owns the
// domain separation and the reduction, the caller owns the ceremony. Nothing
// here touches `navigator.credentials` — the SDK ships to Node, and the
// browser half belongs to whoever calls `deriveNskFromPasskey`.
//
// The PRF extension is the only deterministic secret a passkey can produce.
// A WebAuthn assertion signature cannot be used the way `metamask.ts` uses an
// EIP-712 one: WebAuthn is ECDSA over secp256r1 with a random nonce, so the
// same credential signing the same challenge twice yields two different
// signatures, and a wallet derived from one would not be found again. PRF
// output is keyed by (credential, salt) and is stable for the life of the
// credential, which is what makes it a key source at all.
//
// The consequence is worth stating plainly: the credential *is* the wallet.
// There is no mnemonic behind it, so a caller offering this path owes the user
// an explanation of what losing the authenticator costs.

import { InvalidArgumentError } from "../core/errors.js";
import { BABYJUB_SUBGROUP_ORDER, reduceWideToField } from "../core/field.js";
import { bytesToBareHex, hexToBytes } from "../core/hex.js";
import { keccak256, keccakExpand } from "../core/keccak.js";
import type { Field } from "../crypto/poseidon.js";

/**
 * ASCII bytes of `"lelantos.passkey.prf.nsk.v1\0"`.
 *
 * Distinct from `PK_DOMAIN_TAG_HEX` in `key-source.ts` and from the EIP-712
 * path, so 32 bytes of PRF output that happened to equal a private key still
 * derive a different wallet. Bumping invalidates every passkey-derived wallet;
 * do not change without a coordinated migration.
 */
const PRF_DOMAIN_TAG_HEX = "6c656c616e746f732e706173736b65792e7072662e6e736b2e763100";

/**
 * The salt to pass as WebAuthn's `prf.eval.first`.
 *
 * Fixed forever. The authenticator's PRF is keyed by (credential, salt), so a
 * changed salt against the same credential is a different secret and therefore
 * a different wallet — the same hazard as the domain tag, one layer out.
 *
 * `keccak256` of an ASCII tag rather than a literal blob: 32 bytes is what the
 * extension takes, and deriving them from a readable string keeps the constant
 * auditable.
 */
export const LELANTOS_PRF_SALT: Uint8Array = hexToBytes(
    keccak256(hexToBytes("0x6c656c616e746f732e706173736b65792e7072662e73616c742e763100")),
);

/**
 * The ceremony, as the SDK needs to see it.
 *
 * One method, because one is all the derivation uses: run a WebAuthn assertion
 * with the PRF extension and hand back `prf.results.first`. Implementations
 * live in the browser (see the webapp's `features/passkey`); tests implement it
 * with a fixed array.
 */
export interface PrfEvaluator {
    /** The 32 bytes of `getClientExtensionResults().prf.results.first`. */
    evaluatePrf(salt: Uint8Array): Promise<Uint8Array>;
}

/**
 * `keccakExpand(domainTag || prf, 2) mod BABYJUB_SUBGROUP_ORDER`.
 *
 * Two keccak blocks, not one, for the reason `hexPrivateKeyToNsk` gives: a
 * bare 256-bit digest folded into the 251-bit subgroup order skews residues by
 * about 30:29. See `reduceWideToField`.
 */
export function prfOutputToNsk(prf: Uint8Array): Field {
    if (prf.length !== 32) {
        // The value itself is key material, so only its length is reported.
        throw new InvalidArgumentError(
            `expected 32 bytes of WebAuthn PRF output, got ${prf.length}`,
            { argument: "prf" },
        );
    }
    // Built the way `hexPrivateKeyToNsk` and `x402/ephemeral.ts` build theirs,
    // so the three domain-separated derivations read alike.
    const preimage = hexToBytes(`0x${PRF_DOMAIN_TAG_HEX}${bytesToBareHex(prf)}`);
    return reduceWideToField(keccakExpand(preimage, 2), BABYJUB_SUBGROUP_ORDER, "nsk");
}

/**
 * Run the ceremony and reduce its output to a spending key.
 *
 * The counterpart of `deriveNskFromSigner`. Both are one round trip to
 * something the user controls, and both are deterministic — which is what lets
 * a caller cache the result for a session and re-derive it afterwards rather
 * than storing it.
 */
export async function deriveNskFromPasskey(ev: PrfEvaluator): Promise<Field> {
    return prfOutputToNsk(await ev.evaluatePrf(LELANTOS_PRF_SALT));
}
