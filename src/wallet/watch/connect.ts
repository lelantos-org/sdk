// `connectWatch()` — the watch-only counterpart to `connect()`.
//
// Resolves the same network presets, without key derivation, prover, relayer submitter or signer.
// Asset metadata comes from a `reader`, or one built from `rpcUrl` (loaded on demand).

import {
    isNetworkDeployed,
    type NetworkPreset,
    type PlaceholderNetworkPreset,
} from "../../chain/networks.js";
import type { ChainReader } from "../../chain/port.js";
import { settleAll } from "../../core/async.js";
import { Poseidon } from "../../crypto/index.js";
import { Jubjub } from "../../crypto/jubjub-wasm/index.js";
import { boundary } from "../../errors/boundary.js";
import { NetworkNotDeployedError, WalletConfigError } from "../../errors/config.js";
import { getLogger } from "../../log/logger.js";
import type { ReadOnlyWalletApi } from "../api.js";
import type { ConnectWatchOptions } from "../connect/options.js";
import { namedPreset } from "../connect/preset.js";
import { viemChainOptions } from "../defaults/chain.js";
import { type BuiltScanner, buildScanner, scannerOptionProblems } from "../defaults/scanner.js";
import { configureWalletWasm } from "../defaults/wasm.js";
import { createWatchWallet } from "./watch-wallet.js";

const log = getLogger("lelantos:watch");

/**
 * Connect a watch-only wallet from a viewing key.
 *
 * ```ts
 * const watch = await connectWatch({ network: "base", viewingKey: "lelantosfvk1…", rpcUrl });
 * await watch.sync();
 * ```
 */
export function connectWatch(options: ConnectWatchOptions): Promise<ReadOnlyWalletApi> {
    return boundary("connectWatch", () => connectWatchUnchecked(options));
}

function presetOf(network: unknown): NetworkPreset {
    const named = namedPreset(network);
    if (named) return named;
    const p = network as NetworkPreset | PlaceholderNetworkPreset;
    if (!isNetworkDeployed(p)) throw new NetworkNotDeployedError("<custom>");
    return p;
}

async function connectWatchUnchecked(options: ConnectWatchOptions): Promise<ReadOnlyWalletApi> {
    if (typeof options !== "object" || options === null) {
        throw new WalletConfigError("`connectWatch` takes an options object");
    }
    const preset = presetOf(options.network);
    const missing = [
        ...(options.viewingKey === undefined ? ["`viewingKey`"] : []),
        ...scannerOptionProblems(options.scanner),
    ];
    if (missing.length) throw new WalletConfigError(missing);
    if (options.wasm) await configureWalletWasm(options.wasm);

    const rpcUrl = options.rpcUrl ?? preset.rpcUrl;
    let scanner: BuiltScanner | undefined;
    try {
        let reader: ChainReader | undefined = options.reader;
        if (!reader && rpcUrl) {
            const { ViemChainReader } = await import("../../chain/viem/reader.js");
            reader = new ViemChainReader(viemChainOptions(preset, rpcUrl, options.http?.fetch));
        }
        const P = await Poseidon.build();
        const J = await Jubjub.build();
        scanner = await buildScanner(options.scanner, { P, J });
        const built = scanner.scanner;
        return await createWatchWallet(
            options.viewingKey,
            {
                chainId: preset.chainId,
                fmdUrl: preset.fmdUrl,
                scanner: built,
                ...(reader ? { reader } : {}),
                ...(options.http ? { http: options.http } : {}),
                ...(options.storage?.notes ? { noteStore: options.storage.notes } : {}),
                ...(options.storage?.nullifiers
                    ? { nullifierPersistence: options.storage.nullifiers }
                    : {}),
                ...(options.denominations !== undefined
                    ? { denominations: options.denominations }
                    : {}),
                ...(options.syncStrategy ? { syncStrategy: options.syncStrategy } : {}),
                ...(options.allowDetectionKeyRelease !== undefined
                    ? { allowDetectionKeyRelease: options.allowDetectionKeyRelease }
                    : {}),
            },
            { P, J, scannerOwned: scanner.owned },
        );
    } catch (err) {
        // Only a scanner `connectWatch` built; a caller-supplied one stays with the caller.
        if (scanner?.owned) {
            await settleAll([scanner.scanner.dispose?.()], (err) =>
                log.warn("dispose after a failed connectWatch failed", { err }),
            );
        }
        throw err;
    }
}
