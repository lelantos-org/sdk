// Spending key hierarchy.
//
//   nsk  (root, never leaves owner)
//    ├─ ivk  = Poseidon(TAG_IVK, nsk)
//    │    ├─ pk    = Poseidon(TAG_PK, ivk)        — scalar, binds note commitment
//    │    ├─ pk_d  = (ivk mod q) · Base8          — Baby-Jubjub key, used for ECDH
//    │    └─ dk    = Poseidon(TAG_DK, ivk)        — FMD root detection secret
//    │         └─ ck = (dk mod q) · Base8         — FMD clue key, public
//    └─ nk   = Poseidon(TAG_NK, nsk)              — nullifier-deriving key (FVK)
//
// `dk` carries the detection capability and is released only to a delegate the
// owner chooses. The address publishes `ck`; senders expand it into flag-key
// points via `fmdExpandFlagKey`, which is one-way. The separate `TAG_DK` step
// keeps `ck` distinct from `pk_d`, so the clue stream is unlinked from the
// ECDH key.
//
// Two viewing-key flavors:
//   IncomingViewingKey {ivk, pk_d, dk, ck} — detect + decrypt incoming notes.
//   FullViewingKey     {ivk, pk_d, dk, ck, nk} — adds spent-note visibility:
//     holder can recompute nf = Poseidon(TAG_NF, nk, rho, cm) for any decrypted
//     note's rho and match against the on-chain nullifier set, learning
//     which notes the owner has spent. Cannot derive nsk from nk (Poseidon
//     one-way) so spend authority is NOT granted.

import type { ShieldedAddress } from "../core/brand.js";
import { BABYJUB_SUBGROUP_ORDER } from "../core/field.js";
import { deriveDk, deriveIvk, deriveNk, derivePkFromIvk } from "../crypto/derive.js";
import type { Jubjub, Point } from "../crypto/jubjub.js";
import { WasmJubjub } from "../crypto/jubjub-wasm/index.js";
import { type Field, Poseidon } from "../crypto/poseidon.js";
import {
    assertDetectionGamma,
    FMD_DEFAULT_GAMMA,
    type FmdDetectionKey,
    fmdClueKeyFromRoot,
    fmdExpandDetectionKey,
} from "../fmd/fmd.js";
import { encodeAddress } from "./address.js";
import { mnemonicToAccountKey } from "./hd.js";

/**
 * Incoming viewing key: detects and decrypts this account's incoming notes.
 *
 * Grants neither spend authority nor spend visibility. The latter requires
 * `nk`, which derives from `nsk` rather than `ivk`. See {@link FullViewingKey}.
 */
export interface ViewingKey {
    ivk: Field;
    /** ECDH target, `(ivk mod q) · Base8`. Public; goes in the address. */
    pk_d: Point;
    /** FMD root detection secret. Never publish — see `ck`. */
    dk: Field;
    /** FMD clue key `dk · Base8`. The public half; goes in the address. */
    ck: Point;
}

/**
 * Adds `nk`, with which the holder recomputes nullifiers and so determines
 * which of the account's notes are spent on chain. Grants no spend authority.
 */
export interface FullViewingKey extends ViewingKey {
    nk: Field;
}

/** Full spend authority. A `SpendingKey` satisfies any API that only reads. */
export interface SpendingKey extends FullViewingKey {
    /** Root secret. Never leaves the owner. */
    nsk: Field;
    /** Scalar binding the note commitment, `Poseidon(TAG_PK, ivk)`. */
    pk: Field;
}

export function buildSpendingKey(P: Poseidon, J: Jubjub, nsk: Field): SpendingKey {
    const ivk = deriveIvk(P, nsk);
    // `pk_d`, `dk` and `ck` come from `buildViewingKey`: one derivation for
    // both key kinds, so an account cannot end up with two addresses.
    return {
        ...buildViewingKey(P, J, ivk),
        nsk,
        nk: deriveNk(P, nsk),
        pk: derivePkFromIvk(P, ivk),
    };
}

/**
 * Build an incoming viewing key from `ivk`.
 *
 * `pk_d`, `dk` and `ck` are functions of `ivk` and are derived here, so a
 * serialized viewing key need carry only the scalar.
 */
export function buildViewingKey(P: Poseidon, J: Jubjub, ivk: Field): ViewingKey {
    const dk = deriveDk(P, ivk);
    return {
        ivk,
        pk_d: J.mulPointEscalar(J.base8, ivk % BABYJUB_SUBGROUP_ORDER),
        dk,
        ck: fmdClueKeyFromRoot(J, dk),
    };
}

/** As {@link buildViewingKey}, with the `nk` that grants spend visibility. */
export function buildFullViewingKey(P: Poseidon, J: Jubjub, ivk: Field, nk: Field): FullViewingKey {
    return { ...buildViewingKey(P, J, ivk), nk };
}

/**
 * The address a viewing key watches.
 *
 * An address is `pk_d || pk || ck`, each derivable from `ivk`, so a holder can
 * name the account it views and a caller can check a key against a stated
 * address.
 */
export function addressFromViewingKey(P: Poseidon, J: Jubjub, vk: ViewingKey): ShieldedAddress {
    return encodeAddress(J, vk.pk_d, derivePkFromIvk(P, vk.ivk), vk.ck);
}

/**
 * Narrow a spending key to the incoming-viewing capability.
 *
 * Copies the fields: a `SpendingKey` is assignable to `ViewingKey`, so a cast
 * compiles but leaves `nsk` on the object at runtime.
 */
export function viewingKeyFromSpending(sk: SpendingKey): ViewingKey {
    return { ivk: sk.ivk, pk_d: sk.pk_d, dk: sk.dk, ck: sk.ck };
}

/** As {@link viewingKeyFromSpending}, plus the `nk` that reveals spends. */
export function fullViewingKeyFromSpending(sk: SpendingKey): FullViewingKey {
    return { ...viewingKeyFromSpending(sk), nk: sk.nk };
}

/** @internal */
export function addressFromSpendingKey(J: Jubjub, sk: SpendingKey): ShieldedAddress {
    return encodeAddress(J, sk.pk_d, sk.pk, sk.ck);
}

/**
 * The γ FMD detection scalars for a viewing key, as `POST /v1/subscriptions`
 * expects them via `detectionKeyToHex`.
 *
 * Releasing these releases the root detection secret permanently: `h_i` is
 * public, so any single `x_i` yields `dk = x_i - h_i`.
 *
 * `gamma` is capped at `FMD_SENDER_GAMMA`, not `GAMMA_MAX`: a longer key tests
 * clue bits senders never set and discards the wallet's own notes.
 */
export function detectionKeyFor(
    J: Jubjub,
    P: Poseidon,
    vk: ViewingKey,
    gamma = FMD_DEFAULT_GAMMA,
): FmdDetectionKey {
    assertDetectionGamma(gamma);
    return fmdExpandDetectionKey(J, P, vk.dk, gamma);
}

/** @internal */
export interface DerivedWalletKeys {
    keys: SpendingKey;
    address: string;
}

/**
 * Derive `SpendingKey` + bech32m address from root scalar `nsk`. Pass
 * pre-built `P` / `J` (e.g. from `preloadWasm`) or omit to build defaults.
 */
export async function deriveKeysFromNsk(
    nsk: Field,
    deps?: { P?: Poseidon | undefined; J?: Jubjub | undefined },
): Promise<DerivedWalletKeys> {
    const P = deps?.P ?? (await Poseidon.build());
    const J = deps?.J ?? (await WasmJubjub.build());
    const keys = buildSpendingKey(P, J, nsk);
    return { keys, address: addressFromSpendingKey(J, keys) };
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

/**
 * Mnemonic → `{ keys, address, nsk }`. Wraps `mnemonicToAccountKey` +
 * `deriveKeysFromNsk`.
 */
export async function deriveKeysFromMnemonic(
    opts: DeriveFromMnemonicOpts,
): Promise<DerivedWalletKeys & { nsk: Field }> {
    const esk = mnemonicToAccountKey(opts.mnemonic, opts.account ?? 0, opts.passphrase ?? "");
    const out = await deriveKeysFromNsk(esk.nsk, { P: opts.P, J: opts.J });
    return { ...out, nsk: esk.nsk };
}
