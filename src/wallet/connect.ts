// `Wallet.connect()` — single high-level entrypoint that resolves a
// network preset, builds a chain adapter from a signer/privateKey, picks
// scanner + prover based on runtime, applies WASM loader configuration,
// and calls `Wallet.create`. Replaces the four-step manual wiring shown in
// the README quickstart for 99% of integrations.
//
// Apps that need full control still get it via `Wallet.create(source, cfg)`.

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

/// Supported key derivations. Apps pick exactly one.
export type ConnectKeyOptions =
    | { mnemonic: string; account?: number; passphrase?: string }
    | { signature: string }
    | { nsk: bigint };

export interface ConnectOptions {
    /// Either a builtin preset name (`"anvil"`, `"localnet"`) or a custom
    /// `NetworkPreset` object. Resolves chainId/MASP/relayer/fmd in one go.
    network: NetworkName | NetworkPreset;

    // ── key derivation (exactly one) ────────────────────────────────────
    mnemonic?: string;
    /// ZIP-32 account index for mnemonic-derived nsk. Default 0.
    account?: number;
    passphrase?: string;
    signature?: string;
    nsk?: bigint;

    // ── chain layer — pass *one* of `chain`, `signer`, or `privateKey` ──
    /// Pre-built `ChainAdapter`. Use for viem/web3.js or hardware wallets.
    chain?: ChainAdapter;
    /// Ethers v6 Signer (e.g. from `BrowserProvider.getSigner()`). SDK
    /// builds an `EthersChainAdapter` around it.
    signer?: Signer;
    /// 0x-hex private key. Used for Node tests / scripts.
    privateKey?: string;
    /// JSON-RPC endpoint. Required when building from `signer` (without a
    /// provider) or `privateKey`.
    rpcUrl?: string;

    // ── prover ──────────────────────────────────────────────────────────
    /// Snarkjs / WASM prover artifacts. Pass either the new
    /// `{ circuit, zkey }` shape or the legacy `{ wasmPath, zkeyPath }`.
    /// When omitted, the SDK resolves bundled defaults via
    /// `bundledProverArtifacts()`: companion `@lelantos-org/circuits`
    /// package on Node (`import.meta.resolve`-based). There is NO
    /// browser default — the companion is published to GitHub Packages
    /// which jsDelivr cannot proxy. Browser callers must either pass
    /// this value explicitly (typical: bundler asset import against
    /// `node_modules/@lelantos-org/circuits/2x2/...`) or pass
    /// `proverArtifactsCdn` to point at a self-hosted location.
    proverArtifacts?: ProverArtifacts | ProverPaths;
    /// Self-hosted CDN base URL serving `2x2.wasm` + `2x2_final.zkey`
    /// at the root. Used by `bundledProverArtifacts()` only when
    /// `proverArtifacts` is unset on the browser path. No default.
    proverArtifactsCdn?: string;
    /// Pre-built `Prover`. Skips `proverArtifacts` resolution.
    prover?: Prover;
    /// Use the SDK's WASM Groth16 prover. Default `true` in Node, `true`
    /// in browser when the rayon thread pool can be initialised.
    useWasmProver?: boolean;

    // ── WASM bootstrap ─────────────────────────────────────────────────
    /// Pre-resolved wasm-pack module + binary URLs. Required in browser
    /// builds where bundlers rewrite the SDK's `#wasm/*` subpath imports.
    /// Calls `configureWasm` internally before any `.build()`.
    wasm?: WasmConfig;

    // ── pluggables (override defaults) ─────────────────────────────────
    noteStore?: NoteStore;
    noteSource?: NoteSource;
    submitter?: Submitter;
    selector?: CoinSelector;
    scanner?: Scanner;
    syncStrategy?: SyncStrategy;
    /// Override on-chain `feeBps()` lookup. See `WalletConfig.feeBps`.
    feeBps?: bigint;

    // ── env ────────────────────────────────────────────────────────────
    /// Override runtime detection. Default: auto-detect via
    /// `typeof window` and `process.versions?.node`.
    runtime?: "node" | "browser" | "auto";
}

/// Detect runtime when caller didn't override.
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
    // `EthersChainAdapter` constructs a `JsonRpcProvider` for read-only
    // calls (asset / fee lookups) regardless of whether a signer also
    // brings its own provider. Empty rpcUrl trips ethers'
    // `UNSUPPORTED_OPERATION (protocol="")`, so demand it up front.
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

    // No artifacts + snarkjs path: defer to `Wallet.create` →
    // `defaultProver`, which calls `bundledProverArtifacts()`. Keeps
    // the Node-companion-package + browser-CDN fallback in one place.
    const useWasm = opts.useWasmProver ?? runtime === "node";
    if (!useWasm && !opts.proverArtifacts) return undefined;

    const artifacts = opts.proverArtifacts
        ? opts.proverArtifacts
        : await bundledProverArtifacts({ runtime, cdn: opts.proverArtifactsCdn });
    const paths = resolveArtifacts(artifacts);
    if (!useWasm) return new SnarkjsProver(paths);
    // Dynamic import keeps `WasmProver` (which transitively pulls in
    // `wasm-bindgen-rayon` worker glue) out of bundles that opt out via
    // `useWasmProver: false`.
    const { WasmProver } = await import("./wasm-prover.js");
    return WasmProver.build(paths);
}

/// Single-call wallet construction. Resolves a network preset, builds the
/// chain adapter, picks scanner/prover by runtime, applies the WASM loader,
/// and returns a ready-to-use `WalletApi`.
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
