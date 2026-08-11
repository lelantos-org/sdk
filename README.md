# Lelantos SDK

Client SDK for the Lelantos MASP: shielded deposits, transfers, withdrawals,
note sync, and balances.

The package exposes three layers:

- **Wallet API** — `connect()` returns a `Wallet` implementing `WalletApi`, with
  single-call `deposit` / `transfer` / `withdraw` / `sync` / `balance`.
- **Pluggable interfaces** — `ChainAdapter`, `NoteSource`, `Submitter`,
  `Prover`, `CoinSelector`, and `NoteStore` can each be replaced independently.
- **Primitives** — keys, FMD, note encryption, witness builders, and the prover
  wrapper, for custom flows.

Runtime requirements: Node 24+, modern browsers, or Deno. The SDK uses Web
Crypto and `fetch`; it contains no `node:*` imports.

Full walkthrough: [SDK.md](./SDK.md).

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
   pass `proverArtifacts: { circuit, zkey }` to `connect()` instead; see
   [SDK.md](./SDK.md) for the bundler asset-import pattern.

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
| HRP      | `sswap`                                                                     |
| Encoding | bech32m                                                                     |
| Payload  | 96 B: `pk_d` (32 B, packed Baby-Jubjub) \|\| `dk` (32 B, LE field) \|\| `pk` (32 B, LE field) |

`pk` is published so that any sender can construct a valid note commitment for
the recipient. Spend authority remains gated by `nsk`, which stays private.

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
