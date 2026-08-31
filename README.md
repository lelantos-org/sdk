# Lelantos SDK

Client SDK for the Lelantos MASP: shielded deposits, transfers, withdrawals,
note sync, and balances.

The package exposes three layers:

- **Wallet API** — `connect()` returns a `Wallet` implementing `WalletApi`, with
  single-call `deposit` / `transfer` / `withdraw` / `sync` / `balance`. This is
  the root barrel, and it is all most applications import.
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

   `@lelantos-org/circuits` is an optional peer dependency. When present,
   `connect()` resolves prover artifacts automatically on Node. Browser callers
   pass `proverArtifacts: { circuit, zkey }` to `connect()` instead; see the
   [browser guide](https://docs.lelantos.xyz/guide/browser) for the bundler
   asset-import pattern.

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

> **Legacy `sswap1…` and `sswap2…` addresses are rejected.** The HRP identifies
> the format, so superseded strings fail fast on the HRP check. The oldest
> format (`sswap1…`) additionally published `dk` itself, which handed the
> detection capability to everyone holding the address: any holder could test
> every on-chain clue and enumerate the recipient's incoming notes at a 2^-γ
> false-positive rate. There is no compatibility path — any legacy string that
> got past the HRP check would still fail the `ck` curve checks. Clues already
> on chain remain testable against an `sswap1…` address that was published, so
> treat those receipts as public.

## Browser CSP

WASM modules are loaded through ESM dynamic `import()`; neither `new Function`
nor `eval` is used. Allow `'wasm-unsafe-eval'` in the `script-src` directive;
nothing else is required under the default CSP.

If a bundler rewrites the package's `#wasm/*` subpath imports, pass a
`wasm: { … }` loader to `connect()` so the runtime resolves the modules through
the bundler's asset pipeline.

## Development

```bash
npm test          # vitest suite
npm run build     # tsc → dist/
npm run check     # biome lint + format
npm run typecheck # tsc --noEmit, source and tests
```

## Stability

Pre-1.0: no semantic-versioning guarantees apply before `v1.0.0`, and minor
releases may contain breaking API changes. Pin an exact version and review the
changelog before upgrading.
