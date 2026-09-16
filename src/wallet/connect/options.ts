// `connect()` and `connectWatch()` options.
//
// The key and chain groups are exclusive unions built with `Only<>`: passing two members of one
// group is a compile error, not a precedence rule. Pluggables that only an integrator swaps
// (submitter, selector, note source, fee override) are not here: they belong to
// `createWallet(KeySource, WalletConfig)` in `./advanced`.

import type {
    DeployedNetworkName,
    NetworkPreset,
    PlaceholderNetworkPreset,
} from "../../chain/networks.js";
import type { ChainAdapter, ChainReader } from "../../chain/port.js";
import type { WasmConfig } from "../../configure-wasm.js";
import type { EvmAddressLike, ViewingKeyString } from "../../core/brand.js";
import type { FullViewingKey, ViewingKey } from "../../keys/keys.js";
import type { Eip1193ProviderLike, EthSigner } from "../../keys/signer.js";
import type { DenominationPolicy } from "../../protocol/denominations.js";
import type { CircuitShape } from "../../protocol/shape.js";
import type { Prover, ProverArtifacts } from "../../prover/types.js";
import type { WorkerFactory } from "../../runtime/rpc/types.js";
import type { NullifierPersistence } from "../../sync/nullifier-store.js";
import type { Scanner } from "../../sync/scanner.js";
import type { TreePersistence } from "../../sync/tree-store.js";
import type { NoteStore } from "../notes/note-store.js";
import type { SyncStrategy } from "../types/config.js";

export type { DeployedNetworkName, SyncStrategy };

/** `0x`-prefixed hex. */
export type Hex = `0x${string}`;

/**
 * Marks every sibling key the variant does not own as `?: never`, so mixing two variants of an
 * exclusive group fails to compile.
 */
type Only<T, Keys extends PropertyKey> = T & { [K in Exclude<Keys, keyof T>]?: never };

// --- network -------------------------------------------------------------------------------------

// `NetworkPreset` / `PlaceholderNetworkPreset` live in `chain/networks.ts` (tier 4), which
// `NETWORKS` is typed against; re-exported so there is one definition.
export type { NetworkPreset, PlaceholderNetworkPreset };

export interface NetworkOptions {
    /** A deployed preset name, or a full preset. A placeholder name does not compile. */
    network: DeployedNetworkName | NetworkPreset;
    /**
     * Overrides `preset.rpcUrl`. Required (here or on the preset) unless the chain group is a
     * pre-built `chain` or `reader`; missing, it fails `WALLET_CONFIG` before any signing prompt.
     */
    rpcUrl?: string | undefined;
}

// --- key source ----------------------------------------------------------------------------------

type KeyKeys = "mnemonic" | "account" | "passphrase" | "signature" | "nsk";

/**
 * Where the shielded spending key comes from. At most one.
 *
 * May be omitted when the chain group can derive one (`privateKey`, `signer`, `provider`); see
 * {@link ConnectOptions}.
 */
export type KeyOptions =
    | Only<
          {
              /** BIP-39 phrase, ZIP-32 derived. */
              mnemonic: string;
              /** ZIP-32 account index. Default 0. */
              account?: number | undefined;
              passphrase?: string | undefined;
          },
          KeyKeys
      >
    /** Signature over the canonical EIP-712 key-derivation message. */
    | Only<{ signature: Hex }, KeyKeys>
    /** A nullifier spending key the caller derived (e.g. `deriveNskFromPasskey`) or cached. */
    | Only<{ nsk: bigint }, KeyKeys>;

/** No explicit key source. */
type NoKey = { [K in KeyKeys]?: never };

// --- chain layer ---------------------------------------------------------------------------------

type ChainKeys = "chain" | "reader" | "readOnly" | "signer" | "provider" | "address" | "privateKey";

/**
 * How the wallet reads the chain and, where it can, signs as an EOA. Exactly one.
 *
 * Only deposits (and cancel / allowance setup) need an EOA. Transfers, withdrawals and swaps are
 * authorised by the proof and broadcast by the relayer, so a `readOnly` or `reader` wallet spends
 * normally; `capabilities.deposit` is `false` for it.
 */
export type ChainOptions =
    /** A pre-built adapter; the caller owns its construction and signer. */
    | Only<{ chain: ChainAdapter }, ChainKeys>
    /** A pre-built read-only layer. */
    | Only<{ reader: ChainReader }, ChainKeys>
    /** Build a read-only layer from `rpcUrl`. */
    | Only<{ readOnly: true }, ChainKeys>
    | Only<{ signer: EthSigner }, ChainKeys>
    /** Browser: an EIP-1193 provider and the account to sign as. */
    | Only<{ provider: Eip1193ProviderLike; address: EvmAddressLike }, ChainKeys>
    /** Node scripts and tests. */
    | Only<{ privateKey: Hex }, ChainKeys>;

/**
 * Chain layers holding a key the shielded key can be derived from: `privateKey` by domain-separated
 * reduction, `signer` / `provider` by one EIP-712 signature (the only prompt `connect` issues).
 */
type SelfKeyingChainOptions = Exclude<
    ChainOptions,
    { chain: ChainAdapter } | { reader: ChainReader } | { readOnly: true }
>;

// --- pluggables ----------------------------------------------------------------------------------

/**
 * How proofs are made.
 *
 * - a `Prover`: used as-is and owned by the caller: neither `wallet.dispose()` nor a failed
 *   `connect` disposes it, so one prover (e.g. a tab-wide `WorkerProver`) can serve many wallets;
 * - a {@link ProverConfig}: the SDK builds one (default `{ warmup: "lazy" }`) and disposes it with
 *   the wallet;
 * - `"none"`: no prover; spends reject `PROVER_UNAVAILABLE` and `capabilities.prove` is `false`.
 */
export type ProverOption = Prover | ProverConfig | "none";

export interface ProverConfig {
    /** Circuit artifacts. Node default: the `@lelantos-org/circuits` companion package. */
    artifacts?: ProverArtifacts | undefined;
    /** Self-hosted base URL serving `<shape>.wasm` and `<shape>_final.zkey`. */
    cdn?: string | undefined;
    /** `"auto"` (default): wasm, falling back to snarkjs when wasm fails to load. */
    backend?: "auto" | "wasm" | "snarkjs" | undefined;
    /**
     * `"lazy"` (default): nothing is fetched until the first proof or `warmProver()`, so `connect`
     * does no artifact I/O. `"eager"`: start fetching and warming in the background once connected.
     */
    warmup?: "lazy" | "eager" | undefined;
    /** Run proving in a worker built by this factory. */
    worker?: WorkerFactory | undefined;
    /** Prover thread count. Default: runtime concurrency. */
    threads?: number | undefined;
    /** Keeps a `Prover` from also matching this shape. */
    prove?: never;
}

/**
 * How notes are trial-decrypted: a `Scanner`, a worker pool (`size` default 2–8 by concurrency),
 * or `"inline"` (default, main thread).
 *
 * A `Scanner` instance is owned by the caller: `wallet.dispose()` and a failed `connect` leave it
 * running, so release it yourself. A pool built from `{ workers }` is the SDK's and is disposed
 * with the wallet (or when `connect` fails).
 */
export type ScannerOption =
    | Scanner
    | { workers: WorkerFactory; size?: number | undefined; scan?: never }
    | "inline";

/** One backoff before a retry, as `HttpOptions.onRetry` sees it. */
export interface RetryInfo {
    /** Which client is retrying. */
    service: "relayer" | "fmd" | "quoter";
    /** Redacted. */
    url: string;
    method: string;
    /** 1-based attempt that just failed. */
    attempt: number;
    delayMs: number;
}

/** Transport options forwarded to the relayer, FMD and quoter clients. */
export interface HttpOptions {
    fetch?: typeof fetch | undefined;
    /** Per-attempt deadline for reads and estimates. */
    timeoutMs?: number | undefined;
    /** Per-attempt deadline for spend submits. Overrides `preset.submitTimeoutMs`. */
    submitTimeoutMs?: number | undefined;
    /** Additional attempts after the first. Submits retry only on no response, 429 and 503. */
    retries?: number | undefined;
    /** Must not throw; a throw is logged and swallowed. */
    onRetry?: ((info: RetryInfo) => void) | undefined;
    /** Added to every request, e.g. an API gateway key. */
    headers?: Readonly<Record<string, string>> | undefined;
}

/**
 * Persistence backends. Each defaults to in-memory. Owned by the caller: the SDK reads and writes
 * them but never closes or deletes them, on `dispose()` or on a failed `connect`.
 */
export interface ConnectStorage {
    notes?: NoteStore | undefined;
    tree?: TreePersistence | undefined;
    nullifiers?: NullifierPersistence | undefined;
}

/** Everything that is neither the network, a key source nor a chain layer. */
export interface ConnectExtras {
    /** See {@link ProverOption}; a `Prover` instance is caller-owned and never disposed. */
    prover?: ProverOption | undefined;
    /** See {@link ScannerOption}; a `Scanner` instance is caller-owned and never disposed. */
    scanner?: ScannerOption | undefined;
    http?: HttpOptions | undefined;
    /** See {@link ConnectStorage}; never closed by the SDK. */
    storage?: ConnectStorage | undefined;
    /** Transact circuit arity. Default 4×6, the only shape with published keys. */
    shape?: CircuitShape | undefined;
    /** Withdrawal ladders. Default `true`. */
    denominations?: DenominationPolicy | undefined;
    /** Default `{ kind: "full" }`. */
    syncStrategy?: SyncStrategy | undefined;
    /** Pre-resolved wasm module URLs for bundlers that rewrite `#wasm/*`. */
    wasm?: WasmConfig | undefined;
    /** Default `"auto"`. */
    runtime?: "node" | "browser" | "auto" | undefined;
}

/**
 * Everything `connect()` accepts.
 *
 * A key source may be omitted only when the chain layer derives one, so
 * `connect({ network: "base", rpcUrl, privateKey })` is complete and `connect({ network, readOnly: true })`
 * does not compile.
 */
export type ConnectOptions = NetworkOptions &
    ConnectExtras &
    ((KeyOptions & ChainOptions) | (NoKey & SelfKeyingChainOptions));

// --- watch ---------------------------------------------------------------------------------------

/** Everything `connectWatch()` accepts. Returns a `ReadOnlyWalletApi`. */
export interface ConnectWatchOptions extends NetworkOptions {
    /** Either viewing-key tier, or its bech32m encoding. */
    viewingKey: ViewingKey | FullViewingKey | ViewingKeyString | string;
    /**
     * Asset metadata source. Else built from `rpcUrl` when one is known; with neither, `asset()`
     * and `assets()` reject `WALLET_CONFIG` and no RPC is contacted.
     */
    reader?: ChainReader | undefined;
    scanner?: ScannerOption | undefined;
    http?: HttpOptions | undefined;
    storage?: Omit<ConnectStorage, "tree"> | undefined;
    denominations?: DenominationPolicy | undefined;
    syncStrategy?: SyncStrategy | undefined;
    /**
     * Required for `syncStrategy: { kind: "matches" }`, which releases the account's FMD detection
     * secret to the server permanently.
     */
    allowDetectionKeyRelease?: boolean | undefined;
    wasm?: WasmConfig | undefined;
    runtime?: "node" | "browser" | "auto" | undefined;
}
