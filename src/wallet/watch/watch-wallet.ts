// Watch-only wallet: the read surface of a wallet, built from a viewing key.
//
// Scanning requires only `ivk` (`sync/scan.ts`), so this runs the same `NoteCache`, sync operations
// and read methods (`../surface/read.ts`) as a spending wallet, without a prover, submitter, coin
// selector or Merkle tree.
//
// Must not import `../create.js`, which reaches the per-tx modules and the prover. Enforced by
// `scripts/check-layers.mjs`.

import type { ChainReader } from "../../chain/port.js";
import { createMutex } from "../../core/async.js";
import type { ViewingKeyString } from "../../core/brand.js";
import { Poseidon } from "../../crypto/index.js";
import { Jubjub } from "../../crypto/jubjub-wasm/index.js";
import { boundary } from "../../errors/boundary.js";
import { WalletConfigError } from "../../errors/config.js";
import { addressFromViewingKey, type FullViewingKey, type ViewingKey } from "../../keys/keys.js";
import { decodeViewingKey, isFullViewingKey } from "../../keys/viewing-key.js";
import { getLogger } from "../../log/logger.js";
import { DEFAULT_SHAPE } from "../../protocol/shape.js";
import type { ReadOnlyWalletApi } from "../api.js";
import { lazyAssets } from "../assets/facade.js";
import { NoteCache } from "../notes/note-cache.js";
import { NullifierMemo } from "../notes/sync-ops.js";
import { registerInternals } from "../surface/internals.js";
import { createReadMethods, type ReadContext, walletKeysOf } from "../surface/read.js";
import { WalletStateStore } from "../surface/state.js";
import { resolveWatchConfig, validateWatchConfig, type WatchWalletConfig } from "./config.js";

const log = getLogger("lelantos:watch");

/**
 * Build a watch-only wallet from either viewing-key tier, or its bech32m encoding.
 *
 * The tier is read from the key and reported by `spentKnown` and `keys.tier`.
 *
 * **Ownership.** `dispose()` releases only a scanner the SDK built (the default `LocalScanner`); a
 * `cfg.scanner` passed in stays with the caller. Stores and the reader are never closed.
 */
export function createWatchWallet(
    key: ViewingKey | FullViewingKey | ViewingKeyString | string,
    cfg: WatchWalletConfig,
    deps: {
        P?: Poseidon | undefined;
        J?: Jubjub | undefined;
        /** Whether the SDK built `cfg.scanner`. Default: only when `cfg.scanner` is absent. */
        scannerOwned?: boolean | undefined;
    } = {},
): Promise<ReadOnlyWalletApi> {
    return boundary("connectWatch", async () => {
        validateWatchConfig(cfg);
        const P = deps.P ?? (await Poseidon.build());
        const J = deps.J ?? (await Jubjub.build());
        const keys = typeof key === "string" ? decodeViewingKey(P, J, key) : key;
        const address = addressFromViewingKey(P, J, keys);
        const resolved = await resolveWatchConfig(cfg, { P, J });
        const notes = await NoteCache.open(resolved.noteStore);
        const state = new WalletStateStore(notes);
        const full = isFullViewingKey(keys);
        const ctx: ReadContext = {
            P,
            J,
            keys,
            address,
            notes,
            cfg: resolved,
            ...(full ? { nullifiers: new NullifierMemo(P, keys.nk) } : {}),
            locks: { sync: createMutex() },
            // Asset metadata is the only read that leaves the note cache, so the reader is
            // optional and its absence is reported as a config error by the lookup.
            assets: lazyAssets(() => requireReader(cfg.reader), cfg),
            shape: DEFAULT_SHAPE,
            chain: cfg.reader,
            leases: undefined,
            state,
            log,
            maxScope: "notes",
            release:
                (deps.scannerOwned ?? cfg.scanner === undefined)
                    ? [() => resolved.scanner.dispose?.()]
                    : [],
        };
        const api: ReadOnlyWalletApi = Object.freeze({
            address,
            keys: walletKeysOf(keys, false),
            spentKnown: full,
            shape: DEFAULT_SHAPE,
            ...createReadMethods(ctx),
        });
        registerInternals(api, {
            P,
            J,
            keys,
            noteStore: notes.store,
            noteSource: resolved.noteSource,
            nullifierStore: resolved.nullifierStore,
            scanner: resolved.scanner,
            nullifiers: ctx.nullifiers,
            cache: notes,
            get file() {
                return notes.file;
            },
            storedNotes: () => notes.notes,
            reconcileSpentOnChain: async () => {
                const { reconcileSpentOnChain } = await import("../notes/sync-ops.js");
                await reconcileSpentOnChain(ctx);
            },
        });
        return api;
    });
}

function requireReader(reader: ChainReader | undefined): ChainReader {
    if (!reader) {
        throw new WalletConfigError(
            "`reader` or `rpcUrl` — required for asset metadata, omitted on this watch wallet",
        );
    }
    return reader;
}
