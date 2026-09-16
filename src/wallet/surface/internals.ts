// `walletInternals(wallet)`: the plumbing behind a frozen wallet object, for e2e harnesses, custom
// proofs and tests. Published at `./internal`; carries no stability guarantee.
//
// Kept out of the wallet object itself so a UI holding the wallet never holds the spending key or
// a mutable store handle.

import type { ChainReader } from "../../chain/port.js";
import type { Jubjub, Poseidon } from "../../crypto/index.js";
import { InvalidArgumentError } from "../../errors/config.js";
import type { FullViewingKey, SpendingKey, ViewingKey } from "../../keys/keys.js";
import type { Prover } from "../../prover/types.js";
import type { Submitter } from "../../services/relayer/submitter.js";
import type { NoteSource } from "../../sync/note-source.js";
import type { NullifierStore } from "../../sync/nullifier-store.js";
import type { Scanner } from "../../sync/scanner.js";
import type { TreeStore } from "../../sync/tree-store.js";
import type { ReadOnlyWalletApi, WalletApi } from "../api.js";
import type { NoteLeases } from "../notes/leases.js";
import type { NoteCache } from "../notes/note-cache.js";
import type { NoteStore, NotesFile, StoredNote } from "../notes/note-store.js";
import type { NullifierMemo } from "../notes/sync-ops.js";
import type { CoinSelector } from "../selection/index.js";
import type { ResolvedWalletConfig } from "../types/config.js";

/** What a viewing-key wallet is built from. */
export interface ReadOnlyWalletInternals {
    readonly P: Poseidon;
    readonly J: Jubjub;
    /** Raw key material: a viewing key of either tier. */
    readonly keys: ViewingKey | FullViewingKey;
    readonly noteStore: NoteStore;
    readonly noteSource: NoteSource;
    readonly nullifierStore: NullifierStore;
    readonly scanner: Scanner;
    /** Note id → nullifier; absent for an incoming-tier key. */
    readonly nullifiers: NullifierMemo | undefined;
    /** The in-memory note cache. Mutating it bypasses the wallet's locks. */
    readonly cache: NoteCache;
    /** The live notes file (notes and sync cursor). */
    readonly file: NotesFile;
    storedNotes(): readonly StoredNote[];
    /** Mark notes whose nullifiers the mirrored spent set holds as spent. */
    reconcileSpentOnChain(): Promise<void>;
}

/** What a spending wallet is built from. */
export interface WalletInternals extends ReadOnlyWalletInternals {
    /** The spending key, `nsk` included. */
    readonly keys: SpendingKey;
    readonly nullifiers: NullifierMemo;
    readonly chain: ChainReader;
    readonly treeStore: TreeStore;
    readonly prover: Prover;
    readonly submitter: Submitter;
    readonly selector: CoinSelector;
    readonly cfg: ResolvedWalletConfig;
    /** Notes in-flight spends hold. */
    readonly leases: NoteLeases;
    markSpent(noteIds: readonly string[]): Promise<void>;
    markPendingSpend(noteIds: readonly string[]): Promise<void>;
}

const registry = new WeakMap<object, ReadOnlyWalletInternals>();

/** Associate a wallet object with its internals. Called once, by the constructors. */
export function registerInternals(wallet: object, internals: ReadOnlyWalletInternals): void {
    registry.set(wallet, internals);
}

/**
 * The plumbing behind a wallet `connect()`, `connectWatch()` or `createWallet()` returned.
 *
 * @throws {InvalidArgumentError} for any other object.
 */
export function walletInternals(wallet: WalletApi): WalletInternals;
export function walletInternals(wallet: ReadOnlyWalletApi): ReadOnlyWalletInternals;
export function walletInternals(wallet: ReadOnlyWalletApi): ReadOnlyWalletInternals {
    const found = typeof wallet === "object" && wallet !== null ? registry.get(wallet) : undefined;
    if (!found) {
        throw new InvalidArgumentError(
            "walletInternals: not a wallet built by connect(), connectWatch() or createWallet()",
            { argument: "wallet" },
        );
    }
    return found;
}
