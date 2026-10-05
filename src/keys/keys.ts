// Spending key hierarchy.
//
//   nsk  (root, never leaves owner)
//    ├─ ivk  = Poseidon(TAG_IVK, nsk)
//    │    ├─ dk  = Poseidon(TAG_DK, ivk)          — FMD root detection secret
//    │    ├─ dvk = deriveDiversifierKey(ivk)      — maps an index to a diversifier d
//    │    └─ per address, for d = diversifier(dvk, index) and g_d = diversifiedBase(d):
//    │         ├─ pk   = Poseidon(TAG_PK, ivk, d) — scalar, binds note commitment
//    │         ├─ pk_d = (ivk mod q) · g_d        — Baby-Jubjub key, used for ECDH
//    │         └─ ck_d = (dk mod q) · g_d         — FMD clue key, public
//    └─ nk   = Poseidon(TAG_NK, nsk)              — nullifier-deriving key (FVK)
//
// The key structs hold scalars only. Per-address material is derived on demand
// (`./diversified.ts`), and an address publishes `(d, pk_d, pk, ck_d)`.
//
// `dk` carries the detection capability for every address of the account and is released only to
// a delegate the owner chooses. Senders expand an address's `ck_d` into flag-key points
// (`fmdDiversifiedFlagKey`). The `TAG_DK` step keeps `ck_d` distinct from `pk_d`, so the clue
// stream is unlinked from the ECDH key.

import type { ShieldedAddress } from "../core/brand.js";
import { deriveDk, deriveIvk, deriveNk } from "../crypto/derive.js";
import { Jubjub } from "../crypto/jubjub-wasm/index.js";
import { type Field, Poseidon } from "../crypto/poseidon.js";
import { fmdDiversifiedDetectionKey } from "../fmd/diversified.js";
import { assertDetectionGamma, FMD_DEFAULT_GAMMA, type FmdDetectionKey } from "../fmd/keys.js";
import { encodeAddress } from "./address.js";
import { assertNonZeroModQ, buildDiversifiedKeys } from "./diversified.js";
import { DEFAULT_DIVERSIFIER_INDEX, diversifierForIndex } from "./diversifier.js";

/**
 * Incoming viewing key: detects and decrypts the incoming notes of every address of the account.
 *
 * Grants neither spend authority nor spend visibility; the latter requires the `nk` of a
 * {@link FullViewingKey}, which derives from `nsk`, not `ivk`.
 */
export interface ViewingKey {
    ivk: Field;
    /** FMD root detection secret, `Poseidon(TAG_DK, ivk)`. Never publish. */
    dk: Field;
}

/**
 * Adds `nk`, with which the holder recomputes `nf = Poseidon(TAG_NF, nk, rho, cm)` for a decrypted
 * note and so determines which of the account's notes are spent on chain. `nk` does not yield
 * `nsk`, so it grants no spend authority.
 */
export interface FullViewingKey extends ViewingKey {
    nk: Field;
}

/** Full spend authority. A `SpendingKey` satisfies any API that only reads. */
export interface SpendingKey extends FullViewingKey {
    /** Root secret. Never leaves the owner. */
    nsk: Field;
}

/** @throws {InvalidArgumentError} when the `ivk` or `dk` of `nsk` is zero mod q. */
export function buildSpendingKey(P: Poseidon, nsk: Field): SpendingKey {
    // `dk` comes from `buildViewingKey`, so a spending key and its viewing key always resolve to
    // the same addresses.
    return { ...buildViewingKey(P, deriveIvk(P, nsk)), nsk, nk: deriveNk(P, nsk) };
}

/**
 * Build an incoming viewing key from `ivk`. `dk` is derived from it, so a serialized viewing key
 * carries only the scalar.
 *
 * @throws {InvalidArgumentError} when `ivk` or `dk` is zero mod q: every `pk_d`, respectively
 * every `ck_d`, of the account would be the identity.
 */
export function buildViewingKey(P: Poseidon, ivk: Field): ViewingKey {
    assertNonZeroModQ(ivk, "ivk");
    const dk = deriveDk(P, ivk);
    assertNonZeroModQ(dk, "dk");
    return { ivk, dk };
}

/** As {@link buildViewingKey}, with the `nk` that grants spend visibility. */
export function buildFullViewingKey(P: Poseidon, ivk: Field, nk: Field): FullViewingKey {
    return { ...buildViewingKey(P, ivk), nk };
}

/**
 * The address of a viewing key at diversifier `index`: `d || pk_d || pk || ck_d`, each a function
 * of `ivk` and `index`. Index 0 is the account's default address. Lets a caller check a key
 * against a stated address.
 *
 * @throws {InvalidArgumentError} when `index` is not an integer in `[0, 2^32)`.
 */
export function addressFromViewingKey(
    P: Poseidon,
    J: Jubjub,
    vk: ViewingKey,
    index: number = DEFAULT_DIVERSIFIER_INDEX,
): ShieldedAddress {
    return encodeAddress(J, buildDiversifiedKeys(P, J, vk.ivk, diversifierForIndex(vk.ivk, index)));
}

/**
 * Narrow a spending key to the incoming-viewing capability.
 *
 * Copies the fields: a `SpendingKey` is assignable to `ViewingKey`, so a cast compiles but leaves
 * `nsk` on the object at runtime.
 */
export function viewingKeyFromSpending(sk: SpendingKey): ViewingKey {
    return { ivk: sk.ivk, dk: sk.dk };
}

/** As {@link viewingKeyFromSpending}, plus the `nk` that reveals spends. */
export function fullViewingKeyFromSpending(sk: SpendingKey): FullViewingKey {
    return { ...viewingKeyFromSpending(sk), nk: sk.nk };
}

/**
 * The γ FMD detection scalars for a viewing key, as `POST /v1/subscriptions` expects them via
 * `detectionKeyToHex`. One key detects for every address of the account.
 *
 * Releasing these releases the root detection secret permanently: `h_i` is public, so any single
 * `x_i` yields `dk = x_i - h_i`.
 *
 * `gamma` is capped at `FMD_DEFAULT_GAMMA`, not `GAMMA_MAX`: a longer key tests clue bits senders
 * never set and discards the wallet's own notes.
 */
export function detectionKeyFor(
    P: Poseidon,
    vk: ViewingKey,
    gamma = FMD_DEFAULT_GAMMA,
): FmdDetectionKey {
    assertDetectionGamma(gamma);
    return fmdDiversifiedDetectionKey(P, vk.dk, gamma);
}

/** @internal */
export interface DerivedWalletKeys {
    keys: SpendingKey;
    address: string;
}

/**
 * Derive `SpendingKey` + bech32m address from root scalar `nsk`. The address is the one at
 * diversifier index 0. Pass pre-built `P` / `J` (e.g. from `preloadWasm`) or omit to build
 * defaults.
 */
export async function deriveKeysFromNsk(
    nsk: Field,
    deps?: { P?: Poseidon | undefined; J?: Jubjub | undefined },
): Promise<DerivedWalletKeys> {
    const P = deps?.P ?? (await Poseidon.build());
    const J = deps?.J ?? (await Jubjub.build());
    const keys = buildSpendingKey(P, nsk);
    return { keys, address: addressFromViewingKey(P, J, keys) };
}

/** @internal */
export interface DeriveFromMnemonicOpts {
    mnemonic: string;
    /** ZIP-32 account index. Default 0. */
    account?: number | undefined;
    /** BIP39 passphrase. Default empty. */
    passphrase?: string | undefined;
    /** Optional pre-built primitives (e.g. from `preloadWasm`). */
    P?: Poseidon | undefined;
    J?: Jubjub | undefined;
}
