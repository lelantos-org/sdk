// `Wallet.connect()` — high-level entrypoint. Apps needing full control
// use `Wallet.create(source, cfg)` directly.

import type { Signer } from "ethers";
import type { ProverPaths } from "../prover.js";
import { bundledProverArtifacts, resolveArtifacts } from "../prover.js";
import type { ProverArtifacts } from "../types.js";
import { configureWasm, type WasmConfig } from "../wasm/config.js";
import { EthersChainAdapter } from "./adapters/ethers-chain.js";
import type { ChainAdapter } from "./chain-adapter.js";
import type { SyncStrategy, WalletConfig } from "./config.js";
import { NetworkNotDeployedError, WalletConfigError } from "./errors.js";
import { Wallet, type WalletApi } from "./index.js";
import type { KeySource } from "./key-source.js";
import {
    type DeployedNetworkPreset,
    isNetworkDeployed,
    type NetworkName,
    type NetworkPreset,
    resolveNetwork,
} from "./networks.js";
import type { NoteSource } from "./note-source.js";
import type { NoteStore } from "./note-store.js";
import type { Prover } from "./prover.js";
import { SnarkjsProver } from "./prover.js";
import type { Scanner } from "./scanner.js";
import type { CoinSelector } from "./selection.js";
import type { Submitter } from "./submitter.js";

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

    // chain layer — exactly one of chain / signer / privateKey
    /// For viem/web3.js or hardware wallets.
    chain?: ChainAdapter;
    /// SDK wraps in `EthersChainAdapter`.
    signer?: Signer;
    /// 0x-hex; for Node tests / scripts.
    privateKey?: string;
    /// Required when building from `signer` (without provider) or `privateKey`.
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

function buildChainAdapter(opts: ConnectOptions, preset: DeployedNetworkPreset): ChainAdapter {
    if (opts.chain) return opts.chain;

    const errs: string[] = [];
    if (!opts.signer && !opts.privateKey) {
        errs.push("pass `chain`, `signer`, or `privateKey`");
    }
    // EthersChainAdapter always constructs a JsonRpcProvider for read-only
    // calls; empty rpcUrl trips `UNSUPPORTED_OPERATION (protocol="")`.
    if (!opts.rpcUrl) {
        errs.push("`rpcUrl` required when building chain adapter (or pass a pre-built `chain`)");
    }
    if (errs.length) throw new WalletConfigError(errs);

    return new EthersChainAdapter({
        rpcUrl: opts.rpcUrl as string,
        signer: opts.signer,
        signerKey: opts.privateKey,
        maspAddress: preset.maspAddress,
        chainId: preset.chainId,
        permit2Address: preset.permit2Address,
    });
}

async function buildProver(
    opts: ConnectOptions,
    runtime: "node" | "browser",
): Promise<Prover | undefined> {
    if (opts.prover) return opts.prover;

    // Defer to `Wallet.create` → `defaultProver` when on the snarkjs path
    // without artifacts; keeps fallback resolution in one place.
    const useWasm = opts.useWasmProver ?? runtime === "node";
    if (!useWasm && !opts.proverArtifacts) return undefined;

    const artifacts = opts.proverArtifacts
        ? opts.proverArtifacts
        : await bundledProverArtifacts({ runtime, cdn: opts.proverArtifactsCdn });
    const paths = resolveArtifacts(artifacts);
    if (!useWasm) return new SnarkjsProver(paths);
    // Dynamic import keeps wasm-bindgen-rayon worker glue out of bundles
    // that opt out via `useWasmProver: false`.
    const { WasmProver } = await import("./wasm-prover.js");
    return WasmProver.build(paths);
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
    const chain = buildChainAdapter(opts, preset);
    const prover = await buildProver(opts, runtime);

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
        submitter: opts.submitter,
        prover,
        selector: opts.selector,
        scanner: opts.scanner,
        syncStrategy: opts.syncStrategy,
        feeBps: opts.feeBps,
    };

    return Wallet.create(keySource, cfg);
}
