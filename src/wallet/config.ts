// Wallet runtime configuration.
//
// Every external dependency is pluggable via an interface. Sensible
// defaults are constructed from URL/path-style options when the
// corresponding plug-in isn't supplied — but apps can replace any one
// (chain, source, submitter, prover, selector, store) for tests or
// alternative transports.

import type { ProverPaths } from "../prover";
import type { ChainAdapter } from "./chain-adapter";
import type { NoteStore } from "./note-store";
import type { NoteSource } from "./note-source";

/// Strategy for the default `NoteSource` builder. `full` hits `/v1/notes`
/// (firehose). `matches` hits `/v1/matches?subscription=…` — server runs
/// FMD detection and returns only the false-positive subset for a
/// previously-registered subscription. Ignored when `noteSource` is set
/// directly.
export type SyncStrategy =
    | { kind: "full" }
    | { kind: "matches"; subscriptionId: number };
import type { Submitter } from "./submitter";
import type { Prover } from "./prover";
import type { CoinSelector } from "./selection";
import type { Scanner } from "./scanner";

export interface WalletConfig {
    /// EVM chain id; bound into the SNARK and the FMD-webserver query.
    chainId: bigint;
    /// MASP merkle tree depth (matches the deployed contract + circuit build).
    treeDepth: number;
    /// On-chain relayer eth address. SNARK-bound — must equal the relayer
    /// pipeline's signer address, otherwise the contract reverts BadRelayer.
    relayerAddress: string;
    /// Concrete chain layer (RPC + permit signer). SDK ships an
    /// `EthersChainAdapter`; apps may plug in viem/web3.js.
    chain: ChainAdapter;

    // ---- sensible defaults built from these if pluggables omitted ----
    /// fmd-webserver base URL. Required if `noteSource` is not provided.
    fmdUrl?: string;
    /// Relayer base URL. Required if `submitter` is not provided.
    relayerUrl?: string;
    /// snarkjs paths for transact_2x2. Required if `prover` is not provided.
    proverPaths?: ProverPaths;

    // ---- optional pluggables (override defaults) ----
    /// Where to persist the note cache. Defaults to in-memory if omitted.
    noteStore?: NoteStore;
    /// Source of encrypted notes + merkle paths. Defaults to fmd-webserver.
    noteSource?: NoteSource;
    /// Selects the default `NoteSource` flavor when `noteSource` isn't set.
    /// Defaults to `{ kind: "full" }`.
    syncStrategy?: SyncStrategy;
    /// Transact-bundle submission target. Defaults to HTTP relayer.
    submitter?: Submitter;
    /// Groth16 prover. Defaults to in-process snarkjs.
    prover?: Prover;
    /// Coin-selection strategy. Defaults to SFRT.
    selector?: CoinSelector;
    /// Trial-decrypt scanner. Defaults to in-process `LocalScanner` running
    /// the WASM hot path. Swap for `WorkerPoolScanner` (parallel) when off-
    /// main-thread scan matters.
    scanner?: Scanner;
}
