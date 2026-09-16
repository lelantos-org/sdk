// Runtime configuration for a watch-only wallet.
//
// The shape is picked from `WalletConfig` and the per-pluggable defaults in
// `../defaults/pluggables.ts` are shared. Resolution is separate:
// `../defaults/resolveConfig` builds a prover and a submitter, and a watch
// wallet uses neither.

import type { ChainReader } from "../../chain/port.js";
import type { Jubjub, Poseidon } from "../../crypto/index.js";
import { WalletConfigError } from "../../errors/config.js";
import type { NoteSource } from "../../sync/note-source.js";
import type { NullifierStore } from "../../sync/nullifier-store.js";
import type { Scanner } from "../../sync/scanner.js";
import { LocalScanner } from "../../sync/scanner.js";
import { defaultNoteSource, defaultNullifierStore, lazyFmdClient } from "../defaults/pluggables.js";
import { InMemoryNoteStore, type NoteStore } from "../notes/note-store.js";
import type { WalletConfig } from "../types/config.js";

/**
 * Configuration for `createWatchWallet`, picked from `WalletConfig`.
 *
 * A `Pick`, so a new `WalletConfig` field must be opted into here. Fields
 * serving a proof, a submission or the Merkle tree are excluded.
 */
export interface WatchWalletConfig
    extends Pick<
        WalletConfig,
        | "chainId"
        | "fmdUrl"
        | "noteSource"
        | "noteStore"
        | "nullifierStore"
        | "nullifierPersistence"
        | "scanner"
        | "syncStrategy"
        | "http"
        | "denominations"
        | "feeBps"
    > {
    /**
     * Chain reads, for asset metadata and the chain tip only.
     *
     * Optional: notes come from the note cache. When omitted, `asset()`, `assets()`
     * and `balance()` reject `WALLET_CONFIG` and no RPC is contacted.
     */
    reader?: ChainReader | undefined;

    /**
     * Permit `syncStrategy: { kind: "matches" }`. Off by default.
     *
     * A `matches` subscription posts the γ detection scalars, from which the
     * server recovers `dk` and detects the account's incoming notes
     * permanently. The secret released is the owner's, not the viewer's.
     */
    allowDetectionKeyRelease?: boolean | undefined;
}

/** `WatchWalletConfig` after every default is filled in. */
export interface ResolvedWatchConfig extends WatchWalletConfig {
    noteStore: NoteStore;
    noteSource: NoteSource;
    nullifierStore: NullifierStore;
    scanner: Scanner;
}

/** Collects every problem into one error rather than failing on the first. */
export function validateWatchConfig(cfg: WatchWalletConfig): void {
    const missing: string[] = [];
    if (cfg.chainId === undefined || cfg.chainId === null) missing.push("`chainId`");
    if (!cfg.noteSource && !cfg.fmdUrl) missing.push("`fmdUrl` (or `noteSource`)");
    if (cfg.syncStrategy?.kind === "matches" && !cfg.allowDetectionKeyRelease) {
        missing.push(
            "`allowDetectionKeyRelease: true` (a `matches` subscription releases " +
                "the account's FMD detection secret permanently)",
        );
    }
    if (missing.length) throw new WalletConfigError(missing);
}

export async function resolveWatchConfig(
    cfg: WatchWalletConfig,
    deps: { P: Poseidon; J: Jubjub },
): Promise<ResolvedWatchConfig> {
    const fmdClient = lazyFmdClient(cfg);

    return {
        ...cfg,
        noteStore: cfg.noteStore ?? new InMemoryNoteStore(),
        noteSource: cfg.noteSource ?? defaultNoteSource(fmdClient(), cfg),
        nullifierStore:
            cfg.nullifierStore ??
            (await defaultNullifierStore(fmdClient(), cfg.nullifierPersistence)),
        scanner: cfg.scanner ?? new LocalScanner(deps.J, deps.P),
    };
}
