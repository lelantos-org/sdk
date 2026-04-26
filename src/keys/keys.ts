// Spending key hierarchy.
//
//   nsk  (root, never leaves owner)
//    ├─ ivk  = Poseidon(TAG_IVK, nsk)
//    │    ├─ pk    = Poseidon(TAG_PK, ivk)        — scalar, binds note commitment
//    │    ├─ pk_d  = (ivk mod q) · Base8          — Baby-Jubjub key, used for ECDH
//    │    └─ dk    = Poseidon(TAG_DK, ivk)        — FMD detection-key seed
//    └─ nk   = Poseidon(TAG_NK, nsk)              — nullifier-deriving key (FVK)
//
// Two viewing-key flavors:
//   IncomingViewingKey {ivk, pk_d, dk} — detect + decrypt incoming notes.
//   FullViewingKey     {ivk, pk_d, dk, nk} — adds spent-note visibility:
//     holder can recompute nf = Poseidon(TAG_NF, nk, rho) for any decrypted
//     note's rho and match against the on-chain nullifier set, learning
//     which notes the owner has spent. Cannot derive nsk from nk (Poseidon
//     one-way) so spend authority is NOT granted.

import {
    BABYJUB_SUBGROUP_ORDER,
    deriveDk,
    deriveIvk,
    deriveNk,
    derivePkFromIvk,
    type Field,
    type Jubjub,
    type Point,
    Poseidon,
} from "../crypto/index.js";
import { buildJubjub } from "../crypto/jubjub-wasm.js";
import { encodeAddress } from "./address.js";
import { mnemonicToAccountKey } from "./hd.js";

export interface SpendingKey {
    nsk: Field;
    ivk: Field;
    nk: Field;
    pk: Field;
    pk_d: Point;
    dk: Field;
}

/** @internal */
// Sufficient to trial-decrypt and detect; NOT to spend, NOT to see spends.
export interface ViewingKey {
    ivk: Field;
    pk_d: Point;
    dk: Field;
}

/** @internal */
// Adds nk: holder can also detect which notes have been spent on chain.
// Still NOT sufficient to spend.
export interface FullViewingKey extends ViewingKey {
    nk: Field;
}

export function buildSpendingKey(P: Poseidon, J: Jubjub, nsk: Field): SpendingKey {
    const ivk = deriveIvk(P, nsk);
    return {
        nsk,
        ivk,
        nk: deriveNk(P, nsk),
        pk: derivePkFromIvk(P, ivk),
        pk_d: J.mulPointEscalar(J.base8, ivk % BABYJUB_SUBGROUP_ORDER),
        dk: deriveDk(P, ivk),
    };
}

/** @internal */
export function viewingKeyFromSpending(sk: SpendingKey): ViewingKey {
    return { ivk: sk.ivk, pk_d: sk.pk_d, dk: sk.dk };
}

/** @internal */
export function fullViewingKeyFromSpending(sk: SpendingKey): FullViewingKey {
    return { ivk: sk.ivk, pk_d: sk.pk_d, dk: sk.dk, nk: sk.nk };
}

/** @internal */
export function addressFromSpendingKey(J: Jubjub, sk: SpendingKey): string {
    return encodeAddress(J, sk.pk_d, sk.dk, sk.pk);
}

/** @internal */
export interface DerivedWalletKeys {
    keys: SpendingKey;
    address: string;
}

/// Derive `SpendingKey` + bech32m address from root scalar `nsk`. Pass
/// pre-built `P` / `J` (e.g. from `preloadWasm`) or omit to build defaults.
export async function deriveKeysFromNsk(
    nsk: Field,
    deps?: { P?: Poseidon; J?: Jubjub },
): Promise<DerivedWalletKeys> {
    const P = deps?.P ?? (await Poseidon.build());
    const J = deps?.J ?? (await buildJubjub());
    const keys = buildSpendingKey(P, J, nsk);
    return { keys, address: addressFromSpendingKey(J, keys) };
}

/** @internal */
export interface DeriveFromMnemonicOpts {
    mnemonic: string;
    /// ZIP-32 account index. Default 0.
    account?: number;
    /// BIP39 passphrase. Default empty.
    passphrase?: string;
    /// Optional pre-built primitives (e.g. from `preloadWasm`).
    P?: Poseidon;
    J?: Jubjub;
}

/// Mnemonic → `{ keys, address, nsk }`. Wraps `mnemonicToAccountKey` +
/// `deriveKeysFromNsk`.
export async function deriveKeysFromMnemonic(
    opts: DeriveFromMnemonicOpts,
): Promise<DerivedWalletKeys & { nsk: Field }> {
    const esk = mnemonicToAccountKey(opts.mnemonic, opts.account ?? 0, opts.passphrase ?? "");
    const out = await deriveKeysFromNsk(esk.nsk, { P: opts.P, J: opts.J });
    return { ...out, nsk: esk.nsk };
}
