// `connect()` — the high-level entrypoint. Apps needing full control over
// every pluggable use `Wallet.create` with an explicit `WalletConfig`.
// Default resolution lives in `../defaults/`.

import { isNetworkDeployed, resolveNetwork } from "../../chain/networks.js";
import { configureWasm } from "../../configure-wasm.js";
import { NetworkNotDeployedError } from "../../core/errors.js";
import { resolveArtifacts } from "../../prover/artifacts.js";
import type { WalletConfig } from "../config.js";
import { buildConnectProver, defaultChainAdapter } from "../defaults/index.js";
import { HttpRelayerSubmitter } from "../submitter.js";
import { Wallet } from "../wallet.js";

/**
 * Marks every sibling key the variant does not own as `?: never`, so
 * mixing two mutually-exclusive variants is a compile error rather than a
 * `WalletConfigError` at runtime.
 */

import { buildKeySource, type ConnectOptionsLoose, detectRuntime } from "./key-source.js";

export type {
    ConnectChainOptions,
    ConnectExtraOptions,
    ConnectKeyOptions,
    ConnectOptions,
} from "./options.js";

import type { ConnectOptions } from "./options.js";

export async function connect(options: ConnectOptions): Promise<Wallet> {
    // The exclusive unions have already done their work at the call site;
    // widen once so the body can read fields without narrowing per variant.
    const opts = options as ConnectOptionsLoose;
    if (opts.wasm) configureWasm(opts.wasm);

    const runtime =
        opts.runtime === "auto" || opts.runtime === undefined ? detectRuntime() : opts.runtime;
    const preset = resolveNetwork(opts.network);
    if (!isNetworkDeployed(preset)) {
        const name = typeof opts.network === "string" ? opts.network : "<custom>";
        throw new NetworkNotDeployedError(name);
    }
    const keySource = buildKeySource(opts);
    const chain = defaultChainAdapter(
        {
            chain: opts.chain,
            signer: opts.signer,
            provider: opts.provider,
            address: opts.address,
            privateKey: opts.privateKey,
            rpcUrl: opts.rpcUrl,
        },
        preset,
    );
    const prover = await buildConnectProver(
        {
            prover: opts.prover,
            proverArtifacts: opts.proverArtifacts,
            proverArtifactsCdn: opts.proverArtifactsCdn,
            useWasmProver: opts.useWasmProver,
            proverWarmup: opts.proverWarmup,
        },
        runtime,
    );

    const submitter =
        opts.submitter ??
        (preset.relayerUrl ? new HttpRelayerSubmitter(preset.relayerUrl) : undefined);

    const cfg: WalletConfig = {
        chainId: preset.chainId,
        treeDepth: preset.treeDepth,
        relayerAddress: preset.relayerAddress,
        chain,
        fmdUrl: preset.fmdUrl,
        relayerUrl: preset.relayerUrl,
        proverPaths:
            opts.proverArtifacts && !prover ? resolveArtifacts(opts.proverArtifacts) : undefined,
        noteStore: opts.noteStore,
        noteSource: opts.noteSource,
        treeStore: opts.treeStore,
        treePersistence: opts.treePersistence,
        nullifierStore: opts.nullifierStore,
        nullifierPersistence: opts.nullifierPersistence,
        submitter,
        prover,
        selector: opts.selector,
        scanner: opts.scanner,
        syncStrategy: opts.syncStrategy,
        feeBps: opts.feeBps,
    };

    return Wallet.create(keySource, cfg);
}
