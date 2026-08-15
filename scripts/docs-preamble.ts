// Ambient bindings for the doc examples, copied into the generated program by
// `check-docs.mjs` as a single `.d.ts`.
//
// The guides read as a continuous narrative: a block introduces `wallet`, and
// later blocks use it. Declaring the shared cast here lets each block be
// compiled in isolation while keeping the prose free of setup boilerplate.
//
// Only add a binding when the example is clearer for omitting it. If a value
// is something the SDK itself produces, the example should produce it.

// Imported by package name, not relative path: the doc blocks resolve
// `@lelantos-org/sdk` through package.json#exports to `dist/`, and mixing
// `src/` and `dist/` types makes every branded value incompatible. This also
// means the check validates the built surface consumers actually get.
import type {
    AssetId,
    ChainAdapter,
    CircuitAmount,
    Eip1193ProviderLike,
    EthSigner,
    EvmAddress,
    ShieldedAddress,
    WalletApi,
    WalletConfig,
} from "@lelantos-org/sdk";

declare global {
    // Endpoints and chain wiring.
    const rpcUrl: string;
    const relayerUrl: string;
    const fmdUrl: string;
    const chainId: bigint;
    const chain: ChainAdapter;
    const config: WalletConfig;

    // Key sources.
    const mnemonic: string;
    const privKeyHex: `0x${string}`;
    const nsk: bigint;
    const signer: EthSigner;
    const provider: Eip1193ProviderLike;
    const ethAddress: EvmAddress;

    // Values a preceding block established.
    const wallet: WalletApi;
    const peerBech32: ShieldedAddress;
    const to: ShieldedAddress;
    const amount: CircuitAmount;
    const assetIdValue: AssetId;
    const pk: `0x${string}`;
    const account: `0x${string}`;

    // Values a surrounding function would supply in the pluggable examples.
    const asset: AssetId;
    const keys: import("@lelantos-org/sdk").SpendingKey;
    const viewingKey: import("@lelantos-org/sdk/keys").ViewingKey;
    const target: CircuitAmount;
    const chainTip: number;
    const quoterUrl: string;
    const tokenIn: EvmAddress;
    const tokenOut: EvmAddress;
    const amountIn: bigint;
    const idbGet: (key: string) => Promise<unknown>;
    const idbSet: (key: string, value: unknown) => Promise<void>;
    /** Test-runner assertion, for the mock-pluggable examples. */
    const expect: (actual: unknown) => { toBe(expected: unknown): void };

    /** Stand-in for an app-owned config object in persistence examples. */
    const myAppConfig: Record<string, number | string | undefined>;

    // Entry points the guide establishes once and then uses without repeating
    // the import. Bound to the real signatures so calls are still checked.
    const connect: typeof import("@lelantos-org/sdk").connect;
    const x402: typeof import("@lelantos-org/sdk/x402").x402;
    const browserWorkerProver: typeof import("@lelantos-org/sdk/prover").browserWorkerProver;
    const evmAddress: typeof import("@lelantos-org/sdk").evmAddress;
    const Wallet: typeof import("@lelantos-org/sdk").Wallet;
    const keySource: import("@lelantos-org/sdk").KeySource;
    const cfg: WalletConfig;

    // Caller-supplied values in the browser/bundler examples.
    const wasmUrl: string;
    const zkeyUrl: string;
    const workerUrl: URL;
    const paths: import("@lelantos-org/sdk").ProverPaths;
    const myCache: import("@lelantos-org/sdk/prover").ArtifactCache;

    /** Caller-supplied cancellation, for the examples that accept one. */
    const signal: AbortSignal;
    /**
     * Stand-in for a Node `EventSource` polyfill. Typed as the structural
     * slice `DepositStream` needs; the concrete class belongs to whichever
     * package the caller picks.
     */
    const MyEventSourcePolyfill: new (
        url: string,
    ) => import("@lelantos-org/sdk/relayer").EventSourceLike;

    // Third-party objects the x402 examples hand the SDK's fetch wrapper to.
    // Typed loosely on purpose: their shape belongs to those libraries.
    const url: string;
    const audit: { log(entry: unknown): void };
    const client: { register(network: string, handler: unknown): void };

    interface Window {
        ethereum: Eip1193ProviderLike & { rpcUrl: string };
    }
}
