// `createWallet(KeySource, WalletConfig)`: the advanced construction path, with every pluggable
// under the caller's control. `connect()` builds its config from a preset and lands here too.
//
// Builds a `WalletContext` and returns the frozen wallet object over it (`./surface/api.ts`).
// Operations (`./ops/`) and the spend pipeline (`./tx/`) take the context, never the object. The
// spend path loads with `await import(...)`, so a caller who never spends never downloads the
// prover or viem.

import { settleAll } from "../core/async.js";
import { Poseidon } from "../crypto/index.js";
import { Jubjub } from "../crypto/jubjub-wasm/index.js";
import { InternalError } from "../errors/base.js";
import { boundary } from "../errors/boundary.js";
import { type KeySource, resolveNsk } from "../keys/key-source.js";
import { addressFromSpendingKey, buildSpendingKey } from "../keys/keys.js";
import { getLogger } from "../log/logger.js";
import type { Scanner } from "../sync/scanner.js";
import type { WalletApi } from "./api.js";
import { createWalletContext, type WalletContext } from "./context.js";
import { proverHandleFor, resolveConfig } from "./defaults/index.js";
import type { ProverHandle } from "./defaults/prover.js";
import { validateConfig } from "./defaults/validate.js";
import { NoteCache } from "./notes/note-cache.js";
import { createWalletApi } from "./surface/api.js";
import { WalletStateStore } from "./surface/state.js";
import type { WalletConfig } from "./types/config.js";

const log = getLogger("lelantos:wallet");

/**
 * Build a wallet from any key source, wiring defaults for omitted pluggables. Collects every config
 * problem into `WalletConfigError.missing`.
 *
 * The advanced construction path: use it when `connect()`'s options cannot express the wiring,
 * e.g. to inject a custom `submitter` (a bundler, a capturing test double), `selector`,
 * `noteSource`, pre-built `treeStore` / `nullifierStore`, or a `feeBps` override. `connect()`
 * deliberately does not accept those.
 *
 * The prover defaults to a lazy build over the bundled artifacts, so this does no
 * artifact I/O.
 *
 * **Ownership.** The wallet disposes only what it built. A `Prover` or `Scanner` passed in `cfg`
 * is left running by `wallet.dispose()` and by a failed `createWallet`; the caller releases it.
 * Stores, persistence backends, the chain adapter and the submitter are never closed by the SDK.
 */
export function createWallet(source: KeySource, cfg: WalletConfig): Promise<WalletApi> {
    return boundary("createWallet", async () => {
        validateConfig(cfg);
        return assembleWallet(async () => resolveNsk(source), cfg);
    });
}

/** Pre-built pieces `connect()` hands over instead of letting the config build them. */
interface AssembleDeps {
    P?: Poseidon | undefined;
    J?: Jubjub | undefined;
    prover?: ProverHandle | undefined;
    /**
     * Whether the SDK built `cfg.scanner`. Default: `true` only when `cfg.scanner` is absent (the
     * default `LocalScanner` is built here).
     */
    scannerOwned?: boolean | undefined;
}

/**
 * Everything after validation, in `connect()`'s order: wasm, stores and the note cache first, then
 * the key (the only step that may prompt), then the context and the wallet object. A failure after
 * the prover or scanner exist disposes the ones the SDK built.
 *
 * @internal
 */
export async function assembleWallet(
    nsk: () => Promise<bigint>,
    cfg: WalletConfig,
    deps: AssembleDeps = {},
): Promise<WalletApi> {
    const P = deps.P ?? (await Poseidon.build());
    const J = deps.J ?? (await Jubjub.build());
    const prover = deps.prover ?? proverHandleFor(cfg);
    const scannerOwned = deps.scannerOwned ?? cfg.scanner === undefined;
    let scanner: Scanner | undefined = cfg.scanner;
    try {
        const resolved = await resolveConfig(cfg, { P, J, prover });
        scanner = resolved.scanner;
        const notes = await NoteCache.open(resolved.noteStore);

        // Last: a signer-derived key prompts the user, and nothing after it can fail on config.
        const keys = buildSpendingKey(P, J, await nsk());
        const address = addressFromSpendingKey(J, keys);

        let api: WalletApi | undefined;
        const ctx: WalletContext = createWalletContext({
            P,
            J,
            keys,
            address,
            cfg: resolved,
            notes,
            autoConsolidate: async (asset, selection, parent) => {
                if (!api) {
                    throw new InternalError("autoConsolidate ran before the wallet was built");
                }
                const wallet = api;
                // Loaded with the spend that needs it.
                const { consolidateFor } = await import("./surface/spend.js");
                return consolidateFor(ctx, wallet.awaitCommitments, asset, selection, parent);
            },
        });
        const state = new WalletStateStore(notes);
        api = createWalletApi(ctx, { state, prover, scannerOwned });
        if (prover.eager) {
            prover.warm().catch((err: unknown) => {
                // The next proof rebuilds and surfaces the failure to a caller that can act.
                log.warn("eager prover warm-up failed; retried at the first proof", { err });
            });
        }
        return api;
    } catch (err) {
        await settleAll(
            [
                scannerOwned ? scanner?.dispose?.() : undefined,
                prover.owned ? prover.prover.dispose?.() : undefined,
            ],
            (err) => log.warn("dispose after a failed build failed", { err }),
        );
        throw err;
    }
}
