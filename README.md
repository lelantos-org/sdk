# @lelantos-org/sdk

Client SDK for the Lelantos MASP. Three layers:

- **`WalletApi` interface + `Wallet` class** — opinionated, single-call deposit / transfer / withdraw / sync / balance. Use for app integration.
- **Pluggable interfaces** — `ChainAdapter`, `NoteSource`, `Submitter`, `Prover`, `CoinSelector`, `NoteStore`. Swap any one for tests or alt transports.
- **Low-level primitives** — keys, FMD, note encryption, witness builders, prover wrapper. Use for tests, custom flows, advanced integrations.

Browser-safe: SDK uses Web Crypto + `fetch`; no `node:*` imports. Works in Node 19+, modern browsers, Deno.

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

## Quickstart

```ts
import { Wallet, generateMnemonic } from "@lelantos-org/sdk";

const wallet = await Wallet.connect({
    network: "anvil",            // resolves chainId, MASP, relayer, fmd, treeDepth
    mnemonic: generateMnemonic(),
    privateKey: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
    rpcUrl: "http://localhost:8545",
    proverArtifacts: {
        circuit: "/path/to/circuits/build/2x2_js/2x2.wasm",
        zkey: "/path/to/circuits/build/2x2_final.zkey",
    },
});

console.log("address:", wallet.address);

await wallet.deposit({ amount: 1000n, asset: 1n });
await wallet.sync({ onProgress: (p) => console.log(p.phase, p.fetched) });
console.log("balance:", wallet.balance(1n).toString());

await wallet.transfer({ to: peerBech32, amount: 100n, asset: 1n, autoConsolidate: true });
await wallet.withdraw({ to: "0xf39…", amount: 200n, asset: 1n });
```

Pass `autoConsolidate: true` so transfer/withdraw self-spends the two
smallest notes and retries instead of throwing `InsufficientCoverError`.

### Advanced — full-control wiring

When you need to inject every pluggable yourself (custom indexer, alt
chain library, mocked submitter), reach for `Wallet.create(source, cfg)`
which takes the explicit `WalletConfig`. The single-call `Wallet.connect`
above is built on top of it.

---

## Wallet creation

Three key sources. All produce a deterministic `nsk` field element; the wallet keys (`ivk`, `pk`, `pk_d`, `dk`) and bech32m address derive from it.

### From a BIP39 mnemonic

```ts
import { Wallet, generateNewMnemonic, isValidMnemonic } from "@lelantos-org/sdk";

// Argument is BIP39 entropy bits, NOT word count.
//   256 → 24 words (default, recommended)
//   128 → 12 words
const mnemonic = generateNewMnemonic(256);
if (!isValidMnemonic(mnemonic)) throw new Error("bad seed");

const wallet = await Wallet.create(
    { type: "mnemonic", mnemonic, passphrase: "optional" },
    config,
);
```

### From an EIP-712 signature (MetaMask / hardware wallet)

```ts
import { Wallet, metamask } from "@lelantos-org/sdk";

// Browser flow:
const sig = await metamask.deriveNskFromSigner(ethersSigner);
// → store sig somewhere; pass to Wallet.create:

const wallet = await Wallet.create(
    { type: "signature", signature: sigHex },
    config,
);
```

The canonical EIP-712 typed-data hash is exposed via `metamask.lelantosTypedDataHash()` for offline signing.

### From a raw nsk field element

```ts
const wallet = await Wallet.create(
    { type: "nsk", nsk: 0xdeadbeefn },   // expert / test path
    config,
);
```

---

## Transactions

### Deposit (shield)

```ts
const tx = await wallet.deposit({
    amount: 1000n,            // value in circuit units; on-chain inAmt = value * scale
    asset: 1n,                // optional, default 1
    to: peerBech32,           // optional, default own address
    deadline: 1700000000n,    // optional permit expiry (default: now + 3600s)
});
// tx: { txHash, cm: ["0x...", "0x..."] }
```

The chain adapter signs an EIP-2612 permit so the deposit + ERC20 pull happen in **one** atomic on-chain tx — no separate `approve`.

### Transfer (shielded → shielded)

```ts
const tx = await wallet.transfer({
    to: peerBech32,
    amount: 100n,
    asset: 1n,
    selectOpts: { dustThreshold: 10n },   // optional coin-selector tuning
});
// tx: { txHash, cm, spentNoteIds, inputSum, sent, change }
```

CLI auto-selects up to 2 unspent notes; change returns to self. If no 2-note combination covers the amount, throws with a `consolidate-first` hint:

```ts
try {
    await wallet.transfer({ to, amount });
} catch (e) {
    // "insufficient 2-note cover for ...; consolidate two smallest notes first
    //  (ids: a, b, sum: 70), then re-run"
}
```

To consolidate, send to yourself: `wallet.transfer({ to: wallet.address, amount: smallSum })`.

### Withdraw (shielded → on-chain)

```ts
const tx = await wallet.withdraw({
    to: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
    amount: 200n,
    asset: 1n,
});
// tx: { txHash, cm, spentNoteIds, inputSum, sent, change }
```

Same coin-selection model. Change goes back to self as two new notes (split). MASP sends `outAmt - fee` to the recipient; treasury keeps `fee`.

---

## Note management

### Sync from fmd-webserver

```ts
const r = await wallet.sync({ limit: 1000 });
// { fetched, hits, added, skipped }
```

Pulls encrypted notes, trial-decrypts with the wallet's `ivk`, persists hits to the `NoteStore`. FMD pre-filter cuts down trial decryptions.

### Inspect cache

```ts
wallet.notes();                                    // all
wallet.notes({ asset: 1n, spent: false });         // filter
wallet.balance(1n);                                // bigint, unspent only
```

### Select notes manually

```ts
import { selectNotes } from "@lelantos-org/sdk";

const result = wallet.selectNotes(asset, target, {
    fee: 25n,
    dustThreshold: 100n,
    cooldownBlocks: 2,
    tipBlock: chainTip,
    bucketPct: 0.05,
});

if (result.plan === "direct") {
    console.log(result.notes, result.sum);
} else {
    console.log("consolidate first:", result.consolidate);
}
```

Strategy is **SFRT** — Smallest-First with Random Tiebreak. Avoids the largest-first fingerprint that leaks balance ordering across spends; drains dust over time.

---

## Custom storage

`InMemoryNoteStore` is the default. For persistence, implement the `NoteStore` interface:

```ts
import { type NoteStore, type NotesFile } from "@lelantos-org/sdk";

class IndexedDbNoteStore implements NoteStore {
    async load(): Promise<NotesFile> {
        const json = await idbGet("lelantos-notes") ?? '{"version":2,"notes":[]}';
        return JSON.parse(json);
    }
    async save(file: NotesFile): Promise<void> {
        await idbSet("lelantos-notes", JSON.stringify(file));
    }
}

const wallet = await Wallet.create(keySource, { ...config, noteStore: new IndexedDbNoteStore() });
```

The CLI's [`FileNoteStore`](../cli/src/notes-store.ts) is a working node-side reference.

---

## Custom chain adapter

`EthersChainAdapter` ships in the SDK. To use viem / web3.js / a hardware wallet, implement `ChainAdapter`:

```ts
import { type ChainAdapter, type AssetEntry, signErc2612Permit } from "@lelantos-org/sdk";

class ViemChainAdapter implements ChainAdapter {
    async chainId(): Promise<bigint> { ... }
    async payerAddress(): Promise<string> { ... }
    async fetchAsset(id: bigint): Promise<AssetEntry> { ... }
    async fetchFeeBps(): Promise<bigint> { ... }
    async signPermit(args): Promise<Erc2612Permit> {
        // Reuse the SDK helper; just plug your signer in.
        return signErc2612Permit({ ... });
    }
}
```

---

## Pluggable interfaces

Six injection points on `WalletConfig`. Each has a default; pass your own to swap.

| Interface | Default | Use case |
|---|---|---|
| `ChainAdapter` | `EthersChainAdapter` | viem / web3.js / hardware-wallet signing |
| `NoteSource` | `FmdNoteSource` (over `FmdClient`) | alt indexer, P2P feed, unit-test mock |
| `Submitter` | `HttpRelayerSubmitter` | multi-relayer race, direct-on-chain submit, test mock |
| `Prover` | `SnarkjsProver` (in-process) | remote prover, Web Worker prover, mock |
| `CoinSelector` | `SfrtCoinSelector` | largest-first, Penumbra planner, deterministic test stub |
| `NoteStore` | `InMemoryNoteStore` | file, IndexedDB, encrypted KV |

Plus `WalletApi` itself is an interface — useful for mocking the whole wallet in upstream tests.

### Mock submitter for tests

```ts
import { type Submitter, type SubmitTransactPayload } from "@lelantos-org/sdk";

class MockSubmitter implements Submitter {
    public lastPayload?: SubmitTransactPayload;
    async submit(p: SubmitTransactPayload) {
        this.lastPayload = p;
        return { txHash: "0xdeadbeef" };
    }
}

const submitter = new MockSubmitter();
const wallet = await Wallet.create(keySource, { ...cfg, submitter });
await wallet.deposit({ amount: 100n });
expect(submitter.lastPayload?.permit).toBeDefined();
```

### Custom prover (e.g. remote service)

```ts
import { type Prover } from "@lelantos-org/sdk";

class RemoteProver implements Prover {
    constructor(private url: string) {}
    async prove(input: Record<string, unknown>) {
        const r = await fetch(this.url, { method: "POST", body: JSON.stringify(input) });
        return r.json();
    }
}

const wallet = await Wallet.create(keySource, {
    ...cfg,
    prover: new RemoteProver("https://prover.example.com/prove"),
});
```

### Custom coin selector

```ts
import { type CoinSelector, type StoredNote } from "@lelantos-org/sdk";

class LargestFirstSelector implements CoinSelector {
    select(notes: StoredNote[], asset: bigint, target: bigint) {
        const desc = notes
            .filter((n) => !n.spent && BigInt(n.asset) === asset)
            .sort((a, b) => Number(BigInt(b.value) - BigInt(a.value)));
        const picked = desc.slice(0, 2);
        const sum = picked.reduce((s, n) => s + BigInt(n.value), 0n);
        if (sum < target) throw new Error("insufficient");
        return { plan: "direct", notes: picked, sum };
    }
}

const wallet = await Wallet.create(keySource, { ...cfg, selector: new LargestFirstSelector() });
```

### Custom note source (alt indexer)

```ts
import { type NoteSource, type ScanInput, type MerklePath } from "@lelantos-org/sdk";

class IndexerNoteSource implements NoteSource {
    async listNotes(opts): Promise<ScanInput[]> { /* fetch from your indexer */ }
    async fetchPath(cmHex: string): Promise<MerklePath> { /* fetch from your indexer */ }
}
```

---

## Browser usage

```ts
import { Wallet, EthersChainAdapter, InMemoryNoteStore } from "@lelantos-org/sdk";
import { BrowserProvider } from "ethers";

// Get a signer from MetaMask:
const provider = new BrowserProvider(window.ethereum);
await provider.send("eth_requestAccounts", []);
const signer = await provider.getSigner();

const wallet = await Wallet.create(
    { type: "mnemonic", mnemonic },
    {
        ...config,
        chain: new EthersChainAdapter({
            rpcUrl: "...",
            signer,                  // pass a Signer directly (no privateKey needed)
            maspAddress: "0x...",
        }),
    },
);
```

The prover (`proverPaths`) needs the snarkjs WASM + zkey served somewhere reachable by the browser (e.g. via fetch). Pass URLs.

---

## Low-level primitives

Everything the `Wallet` class uses internally is also exported for direct use:

```ts
import {
    Poseidon, Jubjub,
    buildSpendingKey, addressFromSpendingKey,
    encodeAddress, decodeAddress,
    buildNoteCommitment, buildNullifier,
    MerkleTree,
    encryptNote, decryptNote,
    fmdFlag, fmdTest, fmdGenDetectionKey,
    scanNotes,
    buildDeposit, buildTransfer, buildWithdraw,
    RelayerClient,
    signErc2612Permit,
    prove, verify, configureProver,
} from "@lelantos-org/sdk";
```

The `e2e/runner` consumes these directly without using the `Wallet` class.

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

## Errors

Every typed SDK error inherits from `WalletError` and carries a stable
`code` you can switch on (no string parsing). Catch `WalletError` to
handle every SDK error in one place; reach for the subclass when you
need extra fields:

```ts
import { WalletError, InsufficientCoverError } from "@lelantos-org/sdk/errors";

try {
    await wallet.transfer({ to, amount });
} catch (e) {
    if (e instanceof InsufficientCoverError) { /* … */ }
    else if (e instanceof WalletError) {
        switch (e.code) {
            case "RELAYER_TIMEOUT": ...
            case "FMD_FAILED":      ...
            case "PROVER_FAILED":   ...
            case "PERMIT_REJECTED": ...
            case "WALLET_CONFIG":   ...
        }
    } else throw e;
}
```

- `InsufficientCoverError` (`code: "INSUFFICIENT_COVER"`) — thrown by
  `transfer`/`withdraw` when no 1- or 2-note cover exists. Either pass
  `autoConsolidate: true` to have the SDK self-spend + retry, or read
  `consolidate: StoredNote[]` and orchestrate manually.
- `WalletConfigError` (`code: "WALLET_CONFIG"`) — `missing: string[]`
  lists every problem at once, not one per round-trip.
- `NetworkError` (`code: "RELAYER_*" | "FMD_*"`) — wraps fetch failures
  + timeouts. Reads `url`, `status?`, `cause?`. HTTP clients retry 5xx +
  network errors twice with exponential backoff before throwing.
- `ProverError` (`code: "PROVER_FAILED"`) — proof generation failed.
- `PermitRejectedError` (`code: "PERMIT_REJECTED"`) — user rejected the
  EIP-2612 signature in their wallet.

`HttpClientOptions` (passed via `connect({ http: { timeoutMs, retries } })`
or directly to `FmdClient` / `RelayerClient`) tunes timeout (default
30 000 ms) and retry count (default 2).

