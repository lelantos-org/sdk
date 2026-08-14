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
    FMD_DEFAULT_GAMMA,
    type FmdDetectionKey,
    fmdClueKeyFromRoot,
    fmdExpandDetectionKey,
} from "../fmd/fmd.js";
import { encodeAddress } from "./address.js";
import { mnemonicToAccountKey } from "./hd.js";

export interface SpendingKey {
    nsk: Field;
    ivk: Field;
    nk: Field;
    pk: Field;
    pk_d: Point;
    /** FMD root detection secret. Never publish — see `ck`. */
    dk: Field;
    /** FMD clue key `dk · Base8`. The public half; goes in the address. */
    ck: Point;
}

/** @internal */
// Sufficient to trial-decrypt and detect; NOT to spend, NOT to see spends.
export interface ViewingKey {
    ivk: Field;
    pk_d: Point;
    dk: Field;
    ck: Point;
}

/** @internal */
// Adds nk: holder can also detect which notes have been spent on chain.
// Still NOT sufficient to spend.
export interface FullViewingKey extends ViewingKey {
    nk: Field;
}

export function buildSpendingKey(P: Poseidon, J: Jubjub, nsk: Field): SpendingKey {
    const ivk = deriveIvk(P, nsk);
    const dk = deriveDk(P, ivk);
    return {
        nsk,
        ivk,
        nk: deriveNk(P, nsk),
        pk: derivePkFromIvk(P, ivk),
        pk_d: J.mulPointEscalar(J.base8, ivk % BABYJUB_SUBGROUP_ORDER),
        dk,
        ck: fmdClueKeyFromRoot(J, dk),
    };
}

/** @internal */
export function viewingKeyFromSpending(sk: SpendingKey): ViewingKey {
    return { ivk: sk.ivk, pk_d: sk.pk_d, dk: sk.dk, ck: sk.ck };
}

/** @internal */
export function fullViewingKeyFromSpending(sk: SpendingKey): FullViewingKey {
    return { ivk: sk.ivk, pk_d: sk.pk_d, dk: sk.dk, ck: sk.ck, nk: sk.nk };
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
 */
export function detectionKeyFor(
    J: Jubjub,
    P: Poseidon,
    vk: ViewingKey,
    gamma = FMD_DEFAULT_GAMMA,
): FmdDetectionKey {
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
