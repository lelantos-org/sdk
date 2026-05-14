// Wallet runtime configuration. Every external dependency is pluggable.

import type { ProverPaths } from "../prover.js";
import type { ChainAdapter } from "./chain-adapter.js";
import type { NoteSource } from "./note-source.js";
import type { NoteStore } from "./note-store.js";

/// Default `NoteSource` strategy. `full` → `/v1/notes` firehose;
/// `matches` → server-side FMD-filtered `/v1/matches`. Ignored when
/// `noteSource` is set.
export type SyncStrategy = { kind: "full" } | { kind: "matches"; subscriptionId: number };

import type { Prover } from "./prover.js";
import type { Scanner } from "./scanner.js";
import type { CoinSelector } from "./selection.js";
import type { Submitter } from "./submitter.js";

export interface WalletConfig {
    /// Bound into SNARK + FMD query.
    chainId: bigint;
    /// Matches deployed contract + circuit build.
    treeDepth: number;
    /// SNARK-bound; must equal relayer pipeline signer or contract reverts.
    relayerAddress: string;
    chain: ChainAdapter;
    /// Overrides `chain.fetchFeeBps()`. 1 bp = 0.01%.
    feeBps?: bigint;

    /// Required if `noteSource` is not provided.
    fmdUrl?: string;
    /// Required if `submitter` is not provided.
    relayerUrl?: string;
    /// Required if `prover` is not provided.
    proverPaths?: ProverPaths;

    /// Defaults to in-memory.
    noteStore?: NoteStore;
    /// Defaults to fmd-webserver.
    noteSource?: NoteSource;
    /// Default `{ kind: "full" }`.
    syncStrategy?: SyncStrategy;
    /// Defaults to HTTP relayer.
    submitter?: Submitter;
    /// Defaults to in-process snarkjs.
    prover?: Prover;
    /// Defaults to SFRT.
    selector?: CoinSelector;
    /// Defaults to `LocalScanner`. Use `WorkerPoolScanner` for parallel
    /// off-main-thread scan.
    scanner?: Scanner;
}
