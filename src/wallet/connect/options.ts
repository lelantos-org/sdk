// `connect()` option types.
//
// The mutually-exclusive key and chain groups are modelled with `Only<>`, so
// passing two at once is a compile error rather than a silent precedence rule.

import type { Eip1193ProviderLike, EthSigner } from "../../chain/eth-signer.js";
import type { NetworkName, NetworkPreset } from "../../chain/networks.js";
import type { ChainAdapter } from "../../chain/port.js";
import type { WasmConfig } from "../../configure-wasm.js";
import type { CircuitShape } from "../../core/shape.js";
import type { ProverArtifacts } from "../../prover/artifacts.js";
import type { Prover, ProverPaths } from "../../prover/types.js";
import type { Scanner } from "../../sync/scanner.js";
import type { SyncStrategy } from "../config.js";
import type { NoteSource } from "../note-source.js";
import type { NoteStore } from "../note-store.js";
import type { NullifierPersistence, NullifierStore } from "../nullifier-store.js";
import type { CoinSelector } from "../selection.js";
import type { Submitter } from "../submitter.js";
import type { TreePersistence, TreeStore } from "../tree-store.js";

/**
 * Marks every sibling key the variant does not own as `?: never`, so
 * mixing two mutually-exclusive variants is a compile error rather than a
 * `WalletConfigError` at runtime.
 */

type Only<T, Keys extends PropertyKey> = T & { [K in Exclude<Keys, keyof T>]?: never };

type KeyOptionKeys = "mnemonic" | "account" | "passphrase" | "signature" | "nsk";

/**
 * How the shielded spending key is derived — pick exactly one shape.
 *
 * - `mnemonic` — BIP-39 phrase, ZIP-32 derived. The portable option.
 * - `signature` — hex of the canonical EIP-712 message, for wallet-derived
 *   keys where the user already signed (see `keys/metamask.ts`).
 * - `nsk` — pre-derived nullifier spending key; derivation is the caller's.
 */
export type ConnectKeyOptions =
    | Only<
          {
              mnemonic: string;
              /** ZIP-32 account index. Default 0. */
              account?: number | undefined;
              passphrase?: string | undefined;
          },
          KeyOptionKeys
      >
    | Only<{ signature: string }, KeyOptionKeys>
    | Only<{ nsk: bigint }, KeyOptionKeys>;

type ChainOptionKeys = "chain" | "signer" | "provider" | "address" | "privateKey";

/**
 * How transactions reach the chain — pick exactly one shape. Everything
 * but the pre-built `chain` adapter needs an `rpcUrl` for reads.
 */
export type ConnectChainOptions =
    | Only<
          {
              /** Pre-built `ChainAdapter`; caller owns construction. */
              chain: ChainAdapter;
              rpcUrl?: string | undefined;
          },
          ChainOptionKeys
      >
    | Only<
          {
              /** Pre-built `EthSigner` (wraps any wallet via the abstraction). */
              signer: EthSigner;
              rpcUrl: string;
          },
          ChainOptionKeys
      >
    | Only<
          {
              /**
               * Browser entrypoint: raw EIP-1193 provider + the signing
               * account. SDK builds the signer internally.
               */
              provider: Eip1193ProviderLike;
              address: `0x${string}`;
              rpcUrl: string;
          },
          ChainOptionKeys
      >
    | Only<
          {
              /** 0x-hex; for Node tests / scripts. */
              privateKey: `0x${string}`;
              rpcUrl: string;
          },
          ChainOptionKeys
      >;

/** Everything that is not a key source or a chain layer. */
export interface ConnectExtraOptions {
    /** Builtin preset name or custom `NetworkPreset`. */
    network: NetworkName | NetworkPreset;

    /**
     * Prover artifacts. Omitted → `bundledProverArtifacts()` resolves:
     * companion `@lelantos-org/circuits` on Node. Browser has NO default
     * (companion is on GitHub Packages, not jsDelivr-proxiable); pass
     * explicitly or set `proverArtifactsCdn`.
     */
    proverArtifacts?: ProverArtifacts | ProverPaths | undefined;
    /** Self-hosted CDN base serving `<shape>.wasm` + `<shape>_final.zkey` at root. */
    proverArtifactsCdn?: string | undefined;
    /** Skips `proverArtifacts` resolution. */
    prover?: Prover | undefined;
    /**
     * Default `true` (Node and browser). Set `false` to force the
     * in-process snarkjs prover. On wasm load failure the SDK falls back
     * to snarkjs automatically.
     */
    useWasmProver?: boolean | undefined;
    /**
     * `"eager"` (default) starts the zkey fetch/parse + thread-pool
     * spin-up in the background as soon as `connect()` resolves the
     * artifacts; `"lazy"` defers it to the first `prove()`.
     */
    proverWarmup?: "eager" | "lazy" | undefined;

    /**
     * Pre-resolved wasm-pack module + binary URLs. Required in browser
     * builds where bundlers rewrite `#wasm/*` subpath imports. Applied
     * via `configureWasm` before any `.build()`.
     */
    wasm?: WasmConfig | undefined;

    noteStore?: NoteStore | undefined;
    noteSource?: NoteSource | undefined;
    /** Pre-built tree store. Use `treePersistence` instead for the common case. */
    treeStore?: TreeStore | undefined;
    /**
     * Persistence backend for the Merkle tree (e.g. IndexedDB in the browser).
     * The SDK restores state at startup and saves after every sync.
     */
    treePersistence?: TreePersistence | undefined;
    /** Pre-built spent-nullifier store. Use `nullifierPersistence` instead for the common case. */
    nullifierStore?: NullifierStore | undefined;
    /** As `treePersistence`, for the locally mirrored spent-nullifier set. */
    nullifierPersistence?: NullifierPersistence | undefined;
    submitter?: Submitter | undefined;
    selector?: CoinSelector | undefined;
    scanner?: Scanner | undefined;
    syncStrategy?: SyncStrategy | undefined;
    /**
     * Input/output arity of the transact circuit. Defaults to `DEFAULT_SHAPE`
     * (3×3); pass `TRANSACT_2X2` for a pool still on the narrower circuit.
     * Also selects which artifact pair `bundledProverArtifacts` resolves.
     */
    shape?: CircuitShape | undefined;
    /** See `WalletConfig.feeBps`. */
    feeBps?: bigint | undefined;

    /** Default: auto-detect. */
    runtime?: "node" | "browser" | "auto" | undefined;
}

/**
 * Everything `connect()` accepts: one key source, one chain layer, plus
 * the shared options. The key/chain parts are exclusive unions, so an
 * invalid combination (`mnemonic` *and* `nsk`, `signer` *and* `privateKey`)
 * fails to compile instead of throwing at runtime.
 */
export type ConnectOptions = ConnectExtraOptions & ConnectKeyOptions & ConnectChainOptions;

/** Widened view used internally, after the union has done its job. */
