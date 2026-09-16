# Lelantos SDK

Client SDK for the Lelantos MASP: shielded deposits, transfers, withdrawals and swaps, note sync,
and balances.

`connect()` returns a `WalletApi`: a frozen object of bound methods (`deposit`, `transfer`,
`withdraw`, `quoteSwap` / `swap`, `sync`, `balance`, `state` / `subscribe`, …). That, the amount
helpers and the typed errors are the root entry, and they are all most applications import. Every
other name has exactly one home on a subpath (see [Subpaths](#subpaths)).

Runtime requirements: Node 24+, modern browsers, or Deno. The SDK uses Web Crypto and `fetch`; it
contains no `node:*` imports in browser-reachable code.

Full documentation: <https://docs.lelantos.xyz>.

## Installation

The package is published to **GitHub Packages** with restricted access, so consumers need a token
with the `read:packages` scope and an `.npmrc` pointing `@lelantos-org` at that registry — see
[Installation](https://docs.lelantos.xyz/guide/installation).

```bash
export NODE_AUTH_TOKEN=$(gh auth token)   # or a PAT with read:packages
npm install @lelantos-org/sdk viem @lelantos-org/circuits
```

| Peer | Required | Needed for |
| ---- | -------- | ---------- |
| `viem` | **yes** | The chain adapter, signers and key derivation from an EOA. |
| `@lelantos-org/circuits` | no | Prover artifacts, auto-resolved on Node. Browser callers pass `prover: { artifacts: { circuit, zkey } }` (or `cdn`) to `connect()` instead. |
| `snarkjs`, `circom_runtime` | no | The JS witness calculator / fallback prover. Both are imported lazily, only when a proof needs them. |

## Quickstart

```ts
import { connect, formatAmount, isWalletError } from "@lelantos-org/sdk";

const wallet = await connect({
    network: "base",
    rpcUrl: process.env.BASE_RPC_URL, // public presets ship no RPC endpoint
    privateKey: privKeyHex, // also derives the shielded key; or pass mnemonic / signer / provider
});

// Deposit 0.5 WETH. Amounts are decimal strings of the asset's token (or branded circuit units).
const deposit = await wallet.deposit({ asset: "WETH", amount: "0.5" });
await wallet.awaitDeposit(deposit.escrow); // until the relayer flushes it into the tree

await wallet.sync();
const balance = await wallet.balance("WETH");
console.log(formatAmount(balance.spendable, balance.asset, { symbol: true })); // "0.5 WETH"

try {
    await wallet.withdraw({ asset: "WETH", gross: "0.2", recipient: evmAddress });
} catch (err) {
    if (isWalletError(err, "NOTES_HELD")) {
        // err.held, err.retryable === true: notes are leased by another spend; retry shortly.
    } else if (isWalletError(err, "INSUFFICIENT_BALANCE")) {
        // err.available, err.required
    } else throw err;
}

await wallet.dispose();
```

Every method rejects with a `WalletError` (or the `reason` of an `AbortSignal` you passed). Branch on
`isWalletError(err, code)`, which narrows `err` to that code's class and fields, and on
`err.retryable`. Every operation takes `signal`, `onPhase` and an optional `opId`.

`dispose()` releases only what the SDK built for the wallet (a `{ workers }` scanner pool, a prover
built from a `ProverConfig`). A `Prover` or `Scanner` instance you pass to `connect` stays yours:
share it across wallets and release it yourself. Stores are never closed by the SDK.

## Amounts

An `Amount` names its space by shape, never by magnitude:

| Form | Space |
| ---- | ----- |
| `"12.5"` | human decimal string of the asset's token |
| `circuitAmount(12_500n)` or any SDK-returned amount | circuit units (note values, `publicIn` / `publicOut`) |
| `{ baseUnits: 12_500_000n, round? }` | ERC-20 base units |

A plain `bigint` or `number` does not compile. `parseAmount`, `formatAmount`, `toBaseUnits` and
`fromBaseUnits` convert explicitly against an `AssetInfo` (`await wallet.asset("USDC")`).

Withdrawals and swaps state which side of the protocol fee they mean: `{ gross }` is what leaves the
pool (published on-chain), `{ net }` is what arrives. The relayer fee is never inside either; it is
`result.fees.relayer`.

## Subpaths

One home per name: `check:api` fails if a name is published from two subpaths.

| Import | Contents | Stability |
| ------ | -------- | --------- |
| `@lelantos-org/sdk` | `connect`, `WalletApi` and its options/quotes/results, amounts and brands, `NETWORKS`, logging, `configureWasm`, key helpers (`generateMnemonic`, `deriveNskFromSigner`, `deriveNskFromPasskey`, viewing-key and full-viewing-key codecs), every error class and `isWalletError` | semver |
| `@lelantos-org/sdk/watch` | `connectWatch` (returns `ReadOnlyWalletApi`, exported from the root) | semver |
| `@lelantos-org/sdk/x402` | x402 payers (`x402`, `shieldedExact`, `unshieldedExact`, budgets) | semver |
| `@lelantos-org/sdk/advanced` | `createWallet(KeySource, WalletConfig)`, `ChainAdapter` / `ChainReader` ports and the viem adapter, signers, `Submitter` / `HttpRelayerSubmitter`, note stores and sources, tree/nullifier persistence, coin selectors, scanners, `createWatchWallet` | semver, integrator tier |
| `@lelantos-org/sdk/prover` | `Prover`, `WorkerProver`, `WasmProver`, `SnarkjsProver`, artifact resolution and caching | semver, integrator tier |
| `@lelantos-org/sdk/protocol` | fees (`depositTotals`, `withdrawNet`, `grossForNet`), denominations, deposit pulls, units (`RAY`, `toCircuitUnits`), swap sizing, circuit shapes, relayer wire types, bundle builders, Permit2 signing | semver, integrator tier |
| `@lelantos-org/sdk/primitives` | hex/bytes/field/randomness, Poseidon, Jubjub, keys and addresses, note encryption, FMD | semver, integrator tier |
| `@lelantos-org/sdk/services` | `RelayerClient`, `DepositStream`, `FmdClient`, `fetchSwapQuote`, the HTTP client | semver, integrator tier |
| `@lelantos-org/sdk/workers/prover` | prover worker bootstrap (`new Worker(new URL(…))`) | semver |
| `@lelantos-org/sdk/workers/scanner` | scanner worker bootstrap | semver |
| `@lelantos-org/sdk/wasm/{prover,jubjub,poseidon}[/wasm]` | raw wasm-pack modules for bundler setups | semver |
| `@lelantos-org/sdk/internal` | `walletInternals`, circuit internals, stored-note codec, sync engine pieces, test hooks | **unstable** |

Guides for what this README no longer repeats: the bech32m
[address format](https://docs.lelantos.xyz/guide/addresses),
[watch-only wallets](https://docs.lelantos.xyz/guide/watch-only), and
[browser setup](https://docs.lelantos.xyz/guide/browser) — cross-origin isolation, keeping the
package out of your bundler's pre-bundling, spawning workers from your own call site, and the
`'wasm-unsafe-eval'` CSP directive.

## Source layout

`src/` is a dependency ladder: a module may import from its own tier or below, never above.
`scripts/check-layers.mjs` holds the table and enforces it.

| Tier | Directories | What lives there |
| ---- | ----------- | ---------------- |
| 0 | `core/`, `errors/`, `log/`, `runtime/` | Primitives (brands, hex/bytes, field, randomness, async), the error taxonomy (imports only `core/`), logging, environment detection, worker RPC (`runtime/rpc/`) and wasm loaders (`runtime/wasm/`). No protocol knowledge. |
| 1–2 | `crypto/`, `fmd/`, `keys/`, `notes/` | Poseidon/Jubjub, FMD clues, key derivation and addresses, note encoding and encryption. |
| 3 | `protocol/`, `circuit/` | Wire structs the contract and relayer agree on, protocol policy (fees, denominations, deposit pulls, units, circuit shape, note schema, swap sizing), and the circuit witness. |
| 4 | `chain/`, `permit2/`, `prover/`, `services/` | The EVM adapter, Permit2 signing, Groth16 proving, the shared HTTP transport (`services/http/`) and the service clients (relayer, FMD server, quoter). |
| 5 | `bundle/`, `sync/` | Transaction bundles; the scanner, note sync engine, and tree/nullifier mirrors. |
| 6 | `wallet/` | `connect`, the `WalletApi` object and everything it drives: selection, assets, notes, operations (`ops/`), shared spend steps (`tx/`). |
| 7 | `x402/`, `entry/` | The x402 payment mechanisms; `entry/*`, one file per published subpath. |

Two conventions inside a directory: a module too large to read in one sitting becomes a directory
with an `index.ts` barrel for its callers (`wallet/selection/`, `wallet/assets/`), and a service
splits into `wire.ts` (shapes), `decode.ts` (validation) and `client.ts` (routes). Nothing uses
`export *`: each `entry/*` file forwards, by name, from the module that declares it, which is what
keeps `api-surface.json` meaningful.

## Development

```bash
npm test          # vitest suite, including the *.test-d.ts type assertions
npm run build     # rm -rf dist, tsc → dist/
npm run typecheck # tsc --noEmit, source and tests
npm run check     # biome, plus every source check below
npm run check:dist # after a build: size budgets, API diff, publint/attw, packed assets
```

`check` and `check:dist` are what CI runs (`lint.yml` and `ci.yml`), so a green pair locally is a
green pull request:

| Run by | Script | Enforces |
| ------ | ------ | -------- |
| `check` | `check-layers.mjs` | Tier ladder, no `export *`, `wallet/watch/` clear of the spend path, `errors/` imports only `core/`, operations do not import each other, `entry/*` only forwards. |
| `check` | `check-throws.mjs` | No bare `throw new Error` in shipped code; every failure is a typed `WalletError`. |
| `check` | `check-browser-safe.mjs` | No `node:*` imports, and `process.env` / `Buffer` only in allowlisted Node-only files. |
| `check` | `check-entropy.mjs` | No `Math.random`; randomness routes through `core/random.ts`. |
| `check` | `check-wasm-imports.mjs` | Every `#wasm/*` subpath is imported literally. |
| `check:dist` | `bundle-budget.mjs` | Total `dist/` size, each entry's eager graph, and that no entry statically reaches the spend path. |
| `check:dist` | `check-public-api.mjs` | Exported names match `api-surface.json`, and no name is published from two subpaths. Update with `npm run check:api -- --update`. |
| `check:dist` | publint + attw, `check-pack.mjs` | The package resolves as published, and the build's raw assets are in the tarball. |
| — | `npm run check:audit` | No advisory at any level in the production tree. |

## Stability

Pre-1.0: no semantic-versioning guarantees apply before `v1.0.0`, and minor releases may contain
breaking API changes. Pin an exact version and review the changelog before upgrading.
