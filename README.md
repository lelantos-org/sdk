# @lelantos-org/sdk

Client SDK for the Lelantos MASP. Three layers:

- **`WalletApi` interface + `Wallet` class** — opinionated, single-call deposit / transfer / withdraw / sync / balance. Use for app integration.
- **Pluggable interfaces** — `ChainAdapter`, `NoteSource`, `Submitter`, `Prover`, `CoinSelector`, `NoteStore`. Swap any one for tests or alt transports.
- **Low-level primitives** — keys, FMD, note encryption, witness builders, prover wrapper. Use for tests, custom flows, advanced integrations.

Browser-safe: SDK uses Web Crypto + `fetch`; no `node:*` imports. Works in Node 19+, modern browsers, Deno.

> **Usage guide:** see [SDK.md](./SDK.md) for the full walkthrough — wallet creation, deposit/transfer/withdraw, sync + balance, custom storage, pluggables, browser, low-level primitives, and errors.

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

## Layout

```
src/
  crypto/                  poseidon, jubjub, tags, derive, commit, nullifier, merkle, bytes
  witness/
    tree-update.ts         tree_update circuit witness
  witness.ts               transact_2x2 circuit witness
  snark-compression.ts     flatten + (z, y) compression for both circuits
  keys.ts                  key hierarchy + addressFromSpendingKey
  metamask.ts              EIP-712 → nsk
  address.ts               bech32m (HRP "lelantos2", payload = pk_d || dk || pk)
  fmd.ts                   Niwl
  note-encrypt.ts          ECDH + ChaCha20-Poly1305
  note-codec.ts            80-byte plaintext layout
  notes.ts                 Note + EncryptedNote types
  cache.ts                 In-memory note cache (legacy)
  bundle.ts                buildDeposit / buildTransfer / buildWithdraw
  aux.ts                   per-output FMD + ECDH bundle
  prover.ts                snarkjs wrapper
  relayer.ts               wallet → relayer HTTP client (typed payload, includes permit)
  operator.ts              relayer-internal: canonical tree + tree_update prover
  sync.ts                  trial-decrypt loop (scanNotes) + path verification
  permit.ts                EIP-2612 typed-data signer
  wallet/                  HIGH-LEVEL — Wallet class lives here
    index.ts               WalletApi interface + Wallet class
    config.ts              WalletConfig (all pluggables optional)
    key-source.ts          KeySource discriminated union + resolveNsk
    note-store.ts          NoteStore interface + InMemoryNoteStore
    selection.ts           CoinSelector interface + SfrtCoinSelector
    submitter.ts           Submitter interface + HttpRelayerSubmitter
    note-source.ts         NoteSource interface + FmdNoteSource
    prover.ts              Prover interface + SnarkjsProver
    randomness.ts          Web-Crypto Fr + jubjub-scalar samplers
    fmd-client.ts          Typed fmd-webserver HTTP client
    chain-adapter.ts       ChainAdapter interface
    sync.ts                syncWallet helper
    adapters/
      ethers-chain.ts      EthersChainAdapter (ethers v6)
  index.ts                 barrel — re-exports everything
```

---

## Address format

- **HRP**: `lelantos2`
- **Payload (96 B)**: `pk_d (32, packed Baby-Jubjub) || dk (32, LE Field) || pk (32, LE Field)`
- **Encoding**: bech32m

`pk` is published so any sender can construct a valid note commitment for the recipient. Spend authority remains gated by `nsk` (private). See [contracts/src/MASP.sol](../contracts/src/MASP.sol) and the audit notes in repo CLAUDE history.

Old `lelantos1...` addresses (pk-less) are rejected on decode (`bad HRP`).

---

## Circuit parity

`buildNoteCommitment` and `buildNullifier` in `crypto/` are byte-identical to the templates in `circuits/src/lib/note.circom`. `circuits/src/test/helpers.ts` re-exports from this SDK so circuit tests exercise the same code path.

---

## Testing

```bash
npm test              # 37 tests across crypto, address, keys, fmd, permit, selection
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
