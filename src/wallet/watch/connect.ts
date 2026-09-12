// `connectWatch()` — the watch-only counterpart to `connect()`.
//
// Resolves the same network presets, without key derivation, prover build,
// relayer submitter or chain-adapter construction. Asset metadata needs a
// pre-built `chain` adapter, since constructing one needs a signer.

import {
    isNetworkDeployed,
    type NetworkName,
    type NetworkPreset,
    resolveNetwork,
} from "../../chain/networks.js";
import { configureWasm, type WasmConfig } from "../../configure-wasm.js";
import type { ViewingKeyString } from "../../core/brand.js";
import { NetworkNotDeployedError } from "../../core/errors.js";
import type { FullViewingKey, ViewingKey } from "../../keys/keys.js";
import type { WatchWalletConfig } from "./config.js";
import { WatchWallet } from "./watch-wallet.js";

/**
 * {@link WatchWalletConfig} less the two fields the network preset supplies,
 * plus the preset and the key to watch.
 */
export interface ConnectWatchOptions extends Omit<WatchWalletConfig, "chainId" | "fmdUrl"> {
    /** Preset name or a full `NetworkPreset`, as on `connect()`. */
    network: NetworkName | NetworkPreset;
    /** Either viewing-key tier, or its bech32m encoding. */
    viewingKey: ViewingKey | FullViewingKey | ViewingKeyString | string;
    wasm?: WasmConfig | undefined;
}

export async function connectWatch(options: ConnectWatchOptions): Promise<WatchWallet> {
    if (options.wasm) configureWasm(options.wasm);

    const preset = resolveNetwork(options.network);
    if (!isNetworkDeployed(preset)) {
        const name = typeof options.network === "string" ? options.network : "<custom>";
        throw new NetworkNotDeployedError(name);
    }

    const { network: _network, viewingKey, wasm: _wasm, ...rest } = options;
    return WatchWallet.create(viewingKey, {
        ...rest,
        chainId: preset.chainId,
        fmdUrl: preset.fmdUrl,
    });
}
