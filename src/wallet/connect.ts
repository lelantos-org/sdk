// `Wallet.connect()` — high-level entrypoint. Apps needing full control
// use `Wallet.create(source, cfg)` directly.
//
// This module is deliberately thin: it parses `ConnectOptions`, hands
// off default-resolution to `./defaults.ts`, and calls `Wallet.create`.
// Everything chain-/prover-/note-source-default-shaped lives in
// `./defaults.ts`.

import type { ChainAdapter } from "../chain/adapter.js";
import type { Eip1193ProviderLike, EthSigner } from "../chain/eth-signer.js";
import {
    isNetworkDeployed,
    type NetworkName,
    type NetworkPreset,
    resolveNetwork,
} from "../chain/networks.js";
import type { KeySource } from "../keys/key-source.js";
import type { ProverArtifacts } from "../prover/artifacts.js";
import type { Prover } from "../prover/interface.js";
import type { ProverPaths } from "../prover/snarkjs.js";
import { resolveArtifacts } from "../prover/snarkjs.js";
import type { Scanner } from "../sync/scanner.js";
import { configureWasm, type WasmConfig } from "../wasm/config.js";
import type { SyncStrategy, WalletConfig } from "./config.js";
import { buildConnectProver, defaultChainAdapter } from "./defaults.js";
import { NetworkNotDeployedError, WalletConfigError } from "./errors.js";
import { Wallet, type WalletApi } from "./index.js";
import type { NoteSource } from "./note-source.js";
import type { NoteStore } from "./note-store.js";
import type { CoinSelector } from "./selection.js";
import { HttpRelayerSubmitter, type Submitter } from "./submitter.js";
import type { TreePersistence, TreeStore } from "./tree-store.js";

/// Pick exactly one.
export type ConnectKeyOptions =
    | { mnemonic: string; account?: number; passphrase?: string }
    | { signature: string }
    | { nsk: bigint };

export interface ConnectOptions {
    /// Builtin preset name or custom `NetworkPreset`.
    network: NetworkName | NetworkPreset;

    // key derivation — exactly one
    mnemonic?: string;
    /// ZIP-32 account index. Default 0.
    account?: number;
    passphrase?: string;
    signature?: string;
    nsk?: bigint;

    // chain layer — exactly one of chain / signer / {provider,address} / privateKey
    /// Pre-built `ChainAdapter` (caller owns construction).
    chain?: ChainAdapter;
    /// Pre-built `EthSigner` (wraps any wallet via the abstraction).
    signer?: EthSigner;
    /// Browser entrypoint: raw EIP-1193 provider + the signing account.
    /// SDK builds the signer internally.
    provider?: Eip1193ProviderLike;
    address?: `0x${string}`;
    /// 0x-hex; for Node tests / scripts.
    privateKey?: `0x${string}`;
    /// Required when building the default adapter.
    rpcUrl?: string;

    /// Prover artifacts. Omitted → `bundledProverArtifacts()` resolves:
    /// companion `@lelantos-org/circuits` on Node. Browser has NO default
    /// (companion is on GitHub Packages, not jsDelivr-proxiable); pass
    /// explicitly or set `proverArtifactsCdn`.
    proverArtifacts?: ProverArtifacts | ProverPaths;
    /// Self-hosted CDN base serving `2x2.wasm` + `2x2_final.zkey` at root.
    proverArtifactsCdn?: string;
    /// Skips `proverArtifacts` resolution.
    prover?: Prover;
    /// Default `true` in Node; `true` in browser if rayon initialises.
    useWasmProver?: boolean;

    /// Pre-resolved wasm-pack module + binary URLs. Required in browser
    /// builds where bundlers rewrite `#wasm/*` subpath imports. Applied
    /// via `configureWasm` before any `.build()`.
    wasm?: WasmConfig;

    noteStore?: NoteStore;
    noteSource?: NoteSource;
    /// Pre-built tree store. Use `treePersistence` instead for the common case.
    treeStore?: TreeStore;
    /// Persistence backend for the Merkle tree (e.g. IndexedDB in the browser).
    /// The SDK restores state at startup and saves after every sync.
    treePersistence?: TreePersistence;
    submitter?: Submitter;
    selector?: CoinSelector;
    scanner?: Scanner;
    syncStrategy?: SyncStrategy;
    /// See `WalletConfig.feeBps`.
    feeBps?: bigint;

    /// Default: auto-detect.
    runtime?: "node" | "browser" | "auto";
}

function detectRuntime(): "node" | "browser" {
    const isBrowser = typeof window !== "undefined" && typeof document !== "undefined";
    return isBrowser ? "browser" : "node";
}

function buildKeySource(opts: ConnectOptions): KeySource {
    const provided = [
        opts.mnemonic !== undefined,
        opts.signature !== undefined,
        opts.nsk !== undefined,
    ].filter(Boolean).length;
    if (provided === 0) {
        throw new WalletConfigError("pass exactly one of `mnemonic`, `signature`, or `nsk`");
    }
    if (provided > 1) {
        throw new WalletConfigError(
            "pass exactly one of `mnemonic`, `signature`, or `nsk` (multiple supplied)",
        );
    }
    if (opts.mnemonic !== undefined) {
        return {
            type: "mnemonic",
            mnemonic: opts.mnemonic,
            account: opts.account ?? 0,
            passphrase: opts.passphrase,
        };
    }
    if (opts.signature !== undefined) {
        return { type: "signature", signature: opts.signature };
    }
    return { type: "nsk", nsk: opts.nsk! };
}

/// Single-call wallet construction.
///
/// ```ts
/// const wallet = await connect({
///     network: "anvil",
///     mnemonic: "...",
///     privateKey: "0x...",
///     rpcUrl: "http://localhost:8545",
///     proverArtifacts: { circuit: "/path/to/2x2.wasm", zkey: "/path/to/2x2.zkey" },
/// });
/// ```
export async function connect(opts: ConnectOptions): Promise<WalletApi> {
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
        submitter,
        prover,
        selector: opts.selector,
        scanner: opts.scanner,
        syncStrategy: opts.syncStrategy,
        feeBps: opts.feeBps,
    };

    return Wallet.create(keySource, cfg);
}
