// The one object every wallet operation runs on.
//
// Operations (`./ops/`) and the spend pipeline (`./tx/`) take a `WalletContext` rather than the
// wallet object, so a test can run them over stubs (see `src/test-utils/context.ts`).

import { createMutex, type Mutex } from "../core/async.js";
import type { AssetId, ShieldedAddress } from "../core/brand.js";
import type { Jubjub, Poseidon } from "../crypto/index.js";
import type { SpendingKey } from "../keys/keys.js";
import { getLogger, type Logger } from "../log/logger.js";
import { type AssetsFacade, lazyAssets } from "./assets/facade.js";
import { NoteLeases } from "./notes/leases.js";
import type { NoteCache } from "./notes/note-cache.js";
import { NullifierMemo } from "./notes/sync-ops.js";
import { type RelayerInfo, relayerInfo } from "./relayer-info.js";
import type { ConsolidateFirst } from "./selection/index.js";
import type { ResolvedWalletConfig } from "./types/config.js";

interface WalletLocks {
    /**
     * Serialises syncs and the spent-set resync after a refused spend; see `SyncContext.locks`.
     *
     * The other two locks a spend relies on live with the state they guard: the tree lock inside
     * `TreeStore` (`syncVerifiedSnapshot` reads root and paths under it) and the selection lock
     * inside {@link NoteLeases} (select and lease atomically).
     */
    readonly sync: Mutex;
}

export interface WalletContext {
    readonly P: Poseidon;
    readonly J: Jubjub;
    readonly keys: SpendingKey;
    /** Own bech32m shielded address. */
    readonly address: ShieldedAddress;
    /** Every pluggable, resolved: chain, submitter, prover, selector, stores, scanner. */
    readonly cfg: ResolvedWalletConfig;
    /** The in-memory note set and its persistence. */
    readonly notes: NoteCache;
    /** Asset lookup by id, token address or symbol. */
    readonly assets: AssetsFacade;
    readonly locks: WalletLocks;
    /** Notes held by in-flight spends, so concurrent spends select disjoint notes. */
    readonly leases: NoteLeases;
    /** The relayer's `/chains` metadata, TTL-cached. */
    readonly relayerInfo: RelayerInfo;
    /** Note id → nullifier, for reconciling the spent set. */
    readonly nullifiers: NullifierMemo;
    readonly log: Logger;
    /**
     * Self-spend the notes a `consolidate-first` selection named into one, and wait until the
     * merged note is spendable.
     *
     * Bound by the wallet shell, because a merge is a transfer and an operation may not import
     * another (`scripts/check-layers.mjs` rule 7). `parent` is the spend that needs the merge: the
     * nested self-spend runs under its `opId`, and its errors carry `op: "<parent op>:consolidate"`.
     */
    autoConsolidate(
        asset: AssetId,
        selection: ConsolidateFirst,
        parent: { readonly opId: string; readonly op: string },
    ): Promise<void>;
}

/** What {@link createWalletContext} derives the rest from. */
interface WalletContextInit {
    P: Poseidon;
    J: Jubjub;
    keys: SpendingKey;
    address: ShieldedAddress;
    cfg: ResolvedWalletConfig;
    notes: NoteCache;
    autoConsolidate: WalletContext["autoConsolidate"];
}

export function createWalletContext(init: WalletContextInit): WalletContext {
    const { cfg } = init;
    const relayer = relayerInfo(cfg.submitter, cfg.chainId);
    return {
        ...init,
        assets: lazyAssets(() => cfg.chain, cfg, relayer.tokens),
        locks: { sync: createMutex() },
        leases: new NoteLeases(),
        relayerInfo: relayer,
        nullifiers: new NullifierMemo(init.P, init.keys.nk),
        log: getLogger("lelantos:wallet"),
    };
}
