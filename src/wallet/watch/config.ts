// Runtime configuration for a watch-only wallet.
//
// The shape is picked from `WalletConfig` and the per-pluggable defaults in
// `../defaults/pluggables.ts` are shared. Resolution is separate:
// `../defaults/resolveConfig` builds a prover and a submitter, and a watch
// wallet uses neither.

import type { ChainAdapter } from "../../chain/port.js";
import { WalletConfigError } from "../../core/errors.js";
import type { Jubjub, Poseidon } from "../../crypto/index.js";
import type { Scanner } from "../../sync/scanner.js";
import { LocalScanner } from "../../sync/scanner.js";
import type { WalletConfig } from "../config.js";
// Leaf import, not the `../defaults/index.js` barrel: that barrel re-exports
// `defaultChainAdapter`, which reaches the viem adapter and drags it into a
// graph that never builds a chain adapter.
import { defaultNoteSource, defaultNullifierStore, lazyFmdClient } from "../defaults/pluggables.js";
import type { NoteSource } from "../note-source.js";
import { InMemoryNoteStore, type NoteStore } from "../note-store.js";
import type { NullifierStore } from "../nullifier-store.js";

/**
 * Configuration for {@link WatchWallet}, picked from `WalletConfig`.
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
        | "fetchImpl"
        | "denominations"
        | "feeBps"
    > {
    /**
     * Chain adapter, for asset metadata only.
     *
     * Optional: notes and balances come from the note cache. When omitted,
     * `asset()` and `assets()` throw and no RPC is contacted.
     */
    chain?: ChainAdapter | undefined;

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
