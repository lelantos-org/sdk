# Lelantos SDK

Client SDK for the Lelantos MASP: shielded deposits, transfers, withdrawals,
note sync, and balances.

The package exposes four layers:

- **Wallet API** — `connect()` returns a `Wallet` implementing `WalletApi`, with
  single-call `deposit` / `transfer` / `withdraw` / `sync` / `balance`. This is
  the root barrel, and it is all most applications import.
- **Watch-only wallet** — `connectWatch()` from `@lelantos-org/sdk/watch`
  returns a `WatchWallet` built from a viewing key: the same sync, notes and
  balances, with no spend surface. See [Watch-only](#watch-only).
- **Pluggable interfaces** — `ChainAdapter`, `NoteSource`, `Submitter`,
  `Prover`, `CoinSelector`, and `NoteStore` can each be replaced independently.
- **Primitives** — keys, FMD, note encryption, witness builders, and the prover
  wrapper, on their own subpaths (`@lelantos-org/sdk/keys`, `/crypto`, `/fmd`,
  `/notes`, `/bundle`, `/prover`, …) so the root barrel stays small.

Amounts and asset ids are branded types on the way *out* and plain `bigint` on
the way *in*, so `wallet.asset(1n)` and `amount: 100n` need no ceremony while
values the SDK returns stay type-distinct.

Runtime requirements: Node 24+, modern browsers, or Deno. The SDK uses Web
Crypto and `fetch`; it contains no `node:*` imports.

Full documentation: <https://docs.lelantos.xyz>.

## Installation

The package is published to **GitHub Packages** with restricted access.
Consumers need a token with the `read:packages` scope.

1. Add `.npmrc` to the consuming repository:

   ```
   @lelantos-org:registry=https://npm.pkg.github.com
   //npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}
   ```

2. Export a token, then install:

   ```bash
   export NODE_AUTH_TOKEN=$(gh auth token)   # or a PAT with read:packages
   npm install @lelantos-org/sdk @lelantos-org/circuits
   ```

   All peer dependencies are optional:

   | Peer | Needed for |
   | ---- | ---------- |
   | `@lelantos-org/circuits` | Prover artifacts, auto-resolved on Node. Browser callers pass `proverArtifacts: { circuit, zkey }` to `connect()` instead — see the [browser guide](https://docs.lelantos.xyz/guide/browser). |
   | `viem` | The default `ChainAdapter` and signers. Not required to read: `@lelantos-org/sdk/watch` and the key and crypto subpaths do not reach it. |
   | `snarkjs`, `circom_runtime` | The fallback JS prover, used when the WASM one cannot load. |

3. In CI, pass the auto-provisioned `GITHUB_TOKEN`:

   ```yaml
   - run: npm ci
     env:
       NODE_AUTH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
   ```

## Quickstart

```ts
import { connect, formatAmount, parseAmount } from "@lelantos-org/sdk";

const wallet = await connect({
    privateKey: privKeyHex,
    network: "anvil",
    rpcUrl: "http://localhost:8545",
});

const weth = await wallet.asset(1n);
await wallet.deposit({ asset: weth.id, amount: parseAmount("0.5", weth) });
await wallet.sync();
console.log(formatAmount(wallet.balance(weth.id), weth, { symbol: true }));
```

## Amounts

All amounts are expressed in **circuit units**, where
`tokenBaseUnits = amount * asset.scale`. `wallet.asset(id)` resolves an asset's
`scale`, `symbol`, and `decimals`; `parseAmount` and `formatAmount` convert
between circuit units and user-facing decimal strings.

## Address format

| Field    | Value                                                                      |
| -------- | -------------------------------------------------------------------------- |
| HRP      | `lelantos`                                                                  |
| Encoding | bech32m                                                                     |
| Payload  | 96 B: `pk_d` (32 B, packed Baby-Jubjub) \|\| `pk` (32 B, LE field) \|\| `ck` (32 B, packed Baby-Jubjub) |

`pk` is published so that any sender can construct a valid note commitment for
the recipient. Spend authority remains gated by `nsk`, which stays private.

`ck = dk · Base8` is the FMD **clue key** — the public half. A sender expands it
into flag-key points to attach a clue; deriving the detection scalars from it is
a discrete log. Holding an address therefore lets you pay someone, not watch
them.

> **Legacy `sswap1…` and `sswap2…` addresses are rejected**, on the HRP check
> and again on the `ck` curve checks. There is no compatibility path.
>
> `sswap1…` published `dk` itself, so any holder of such an address can test
> every on-chain clue and enumerate that recipient's incoming notes at a 2^-γ
> false-positive rate. Clues already on chain stay testable: treat receipts to a
> published `sswap1…` address as public.

## Watch-only

A viewing key reads an account without being able to spend from it. The tier is
read from the key: `lelantosivk1…` decrypts incoming notes, `lelantosfvk1…` also
resolves which are spent.

```ts
import { encodeFullViewingKey, fullViewingKeyFromSpending } from "@lelantos-org/sdk";
import { connectWatch } from "@lelantos-org/sdk/watch";

const key = encodeFullViewingKey(fullViewingKeyFromSpending(wallet.keys));

const watch = await connectWatch({ network: "anvil", viewingKey: key });
await watch.sync();
watch.balance(weth.id);
watch.spentKnown; // false for an incoming key: balance is gross received
```

`WatchWallet` implements `ReadOnlyWalletApi`; `deposit`, `transfer`, `withdraw`
and `swap` are absent from the type. The entry point reaches neither the prover
nor viem, so a read-only integration installs neither.

> **A viewing key cannot be revoked.** `ivk` is fixed by the spending key, so a
> holder reads every note the account receives from then on. Moving the funds to
> a new account is the only way to withdraw the capability.

## Browser setup

Three things a browser build needs beyond `npm install`. All three fail
quietly rather than loudly, so they are worth doing up front.

### 1. Cross-origin isolation

The prover and the scanner pool use wasm threads (`SharedArrayBuffer`), which
browsers gate behind cross-origin isolation. Serve the app with:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Without these, `crossOriginIsolated` is `false` and the threaded paths throw.

### 2. Do not pre-bundle the SDK

Bundlers that rewrite the wasm-pack glue's `new URL('<crate>_bg.wasm',
import.meta.url)` produce a path that does not exist at runtime. The SDK
catches that and falls back to slower JS — so the symptom is not an error, it
is a wallet roughly 10x slower over the ~350K hashes of a cold tree build.

In Vite:

```ts
export default defineConfig({
    optimizeDeps: { exclude: ["@lelantos-org/sdk"] },
    worker: { format: "es" },
});
```

Every degradation of this kind is logged, and SDK logging is off until you
install a sink — so turn it on, at least in development. Records are forwarded
from the scanner workers too, which is where this particular failure lands:

```ts
import { configureLogging, consoleSink } from "@lelantos-org/sdk";

configureLogging({ level: "warn", sink: consoleSink() });
```

If your bundler rewrites `#wasm/*` and excluding the package is not an option,
pass a `wasm: { … }` loader to `connect()` instead, so the modules resolve
through the asset pipeline.

### 3. Spawn workers from your own call site

Use `fastWallet`, and write the `new Worker(...)` expression inline — bundlers
emit a worker chunk only for that literal form.

```ts
import { fastWallet } from "@lelantos-org/sdk";

const wallet = await fastWallet({
    network: "base",
    provider: window.ethereum,
    address,
    rpcUrl,
    proverArtifacts: { circuit, zkey },
    pool: {
        worker: () =>
            new Worker(new URL("@lelantos-org/sdk/scanner-worker", import.meta.url), {
                type: "module",
            }),
    },
});
```

Call `wallet.dispose()` when abandoning a wallet — on disconnect, account
switch or network switch. The workers are live threads and do not go away when
the wallet goes out of scope.

## Browser CSP

WASM modules are loaded through ESM dynamic `import()`; neither `new Function`
nor `eval` is used. Allow `'wasm-unsafe-eval'` in the `script-src` directive;
nothing else is required under the default CSP.

## Source layout

`src/` is a dependency ladder: a module may import from its own tier or below,
never above. `check:layers` enforces it, and the tiers below are the table that
script holds.

| Tier | Directories | What lives there |
| ---- | ----------- | ---------------- |
| 0 | `core/`, `log/`, `worker/`, `wasm/` | Brands, field arithmetic, decoding, HTTP, fees, denominations, logging, wasm + worker plumbing. No protocol knowledge. |
| 1–2 | `crypto/`, `fmd/`, `keys/`, `notes/` | Poseidon/Jubjub, FMD clues, key derivation and addresses, note encoding and encryption. |
| 3 | `protocol/`, `circuit/` | Wire structs the contract and relayer agree on, and the circuit witness built from them. |
| 4 | `chain/`, `permit2/`, `prover/`, `services/` | The EVM adapter, Permit2 signing, Groth16 proving, and the HTTP clients (relayer, FMD server, quoter). |
| 5 | `bundle/`, `sync/` | Transaction bundles, and the scanner that finds notes. |
| 6 | `wallet/` | `Wallet` and everything it drives: selection, assets, per-tx flows, stores. |
| 7 | `presets/`, `x402/`, `index.ts` | Deployment presets, the x402 payment mechanisms, the root barrel. |

Two conventions inside a directory: a module too large to read in one sitting
becomes a directory with an `index.ts` barrel (`wallet/selection/`,
`wallet/assets/`), and a service splits into `wire.ts` (shapes), `decode.ts`
(validation) and `client.ts` (routes). No barrel uses `export *` — every name a
subpath publishes is written out, which is what keeps `api-surface.json`
meaningful.

## Development

```bash
npm test          # vitest suite
npm run build     # tsc → dist/
npm run check     # biome lint + format
npm run typecheck # tsc --noEmit, source and tests
```

CI enforces more than the four above. Each has its own script, and all run on
every pull request:

| Script | Enforces |
| ------ | -------- |
| `check:api` | Exported names match `api-surface.json`. Update with `-- --update`. |
| `check:layers` | Tier ladder, no `export *`, `wallet/watch/` clear of the spend path. |
| `check:browser-safe` | No `node:*` imports under `src/`. |
| `check:entropy` | No `Math.random`; randomness routes through `core/random.ts`. |
| `check:wasm-imports` | Every `#wasm/*` subpath is imported literally. |
| `check:bundle-size` / `check:bundle-budget` | Total `dist/` size, and the eager graph of each entry point. |
| `check:publish` / `check:pack` | publint + attw, and that `exports` resolves in a packed tarball. |
| `check:audit` | No advisory at any level in the production tree. |

## Stability

Pre-1.0: no semantic-versioning guarantees apply before `v1.0.0`, and minor
releases may contain breaking API changes. Pin an exact version and review the
changelog before upgrading.
