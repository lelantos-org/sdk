# @lelantos-org/sdk

Client SDK for the Lelantos MASP. Three layers:

- **`WalletApi` interface + `Wallet` class** — opinionated, single-call deposit / transfer / withdraw / sync / balance. Use for app integration.
- **Pluggable interfaces** — `ChainAdapter`, `NoteSource`, `Submitter`, `Prover`, `CoinSelector`, `NoteStore`. Swap any one for tests or alt transports.
- **Low-level primitives** — keys, FMD, note encryption, witness builders, prover wrapper. Use for tests, custom flows, advanced integrations.

Browser-safe: SDK uses Web Crypto + `fetch`; no `node:*` imports. Works in Node 24+, modern browsers, Deno.

> **Usage guide:** see [SDK.md](./SDK.md) for the full walkthrough — wallet creation, deposit/transfer/withdraw, sync + balance, custom storage, pluggables, browser, low-level primitives, and errors.

```ts
import { Wallet } from "@lelantos-org/sdk";

const wallet = await Wallet.fromPrivateKey(privKeyHex, {
    network: "anvil",
    rpcUrl: "http://localhost:8545",
});
await wallet.deposit({ amount: 1000n, asset: 1n });
```

Three-line happy path. Install the companion `@lelantos-org/circuits`
package alongside the SDK so `Wallet.connect()` auto-resolves prover
artifacts on Node:

```bash
npm install @lelantos-org/sdk @lelantos-org/circuits
```

Browser callers pass `proverArtifacts: { circuit, zkey }` to
`Wallet.connect` explicitly — see SDK.md for the bundler asset-import
pattern.

---

## Installation

Published privately on **GitHub Packages**. Consumers need a token with `read:packages` scope.

1. Create `.npmrc` in the consuming repo:

   ```
   @lelantos-org:registry=https://npm.pkg.github.com
   //npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}
   ```

2. Export a token before installing:

   ```bash
   export NODE_AUTH_TOKEN=$(gh auth token)   # or a PAT with read:packages
   npm install @lelantos-org/sdk
   ```

3. **CI** — pass the auto-provisioned `GITHUB_TOKEN` (same org grants read on packages):

   ```yaml
   - run: npm ci
     env:
       NODE_AUTH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
   ```

---

## Address format

- **HRP**: `lelantos2`
- **Payload (96 B)**: `pk_d (32, packed Baby-Jubjub) || dk (32, LE Field) || pk (32, LE Field)`
- **Encoding**: bech32m

`pk` is published so any sender can construct a valid note commitment for the recipient. Spend authority remains gated by `nsk` (private). See [contracts/src/MASP.sol](../contracts/src/MASP.sol).

Old `lelantos1...` addresses (pk-less) are rejected on decode (`bad HRP`).

---

## Circuit parity

`buildNoteCommitment` and `buildNullifier` in `crypto/` are byte-identical to the templates in `circuits/src/lib/note.circom`. `circuits/src/test/helpers.ts` re-exports from this SDK so circuit tests exercise the same code path.

---

## Testing

```bash
npm test              # vitest suite across crypto, address, keys, fmd, permit2, selection, scanner
npm run build         # tsc → dist/
```

CLI demo at [`../cli`](../cli) wires this SDK into a `lel` binary covering wallet management, scan, transact, chain debug.

---

## Stability

Pre-1.0. **No semver guarantees** until `v1.0.0`. Minor versions may include breaking API changes. Pin to an exact version (`"@lelantos-org/sdk": "0.1.0"`) and read the changelog before bumping.

## Browser CSP

WASM modules are loaded via real ESM dynamic `import()` calls (no `new
Function`/`eval` — the SDK migrated off that hack). Allow
`'wasm-unsafe-eval'` in your `script-src` directive; nothing else is
needed under the default CSP. If you bundle the SDK and your bundler
rewrites the package's `#wasm/*` subpath imports, pass a `wasm: { … }`
loader to `Wallet.connect()` so the runtime resolves modules through your
bundler's asset pipeline.
