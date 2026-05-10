# SDK Usage Guide

End-to-end walkthrough of `@lelantos-org/sdk`: create wallet, deposit, sync, balance, transfer, withdraw, plus pluggables and error handling.

See [README.md](./README.md) for installation, layout, address format, and stability guarantees.

---

## Quickstart

The shortest path from `npm install` to working wallet — one EVM private
key signs on-chain transactions AND derives the shielded `nsk`:

```ts
import { Wallet } from "@lelantos-org/sdk";

const wallet = await Wallet.fromPrivateKey(
    "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
    { network: "anvil", rpcUrl: "http://localhost:8545" },
);

console.log("address:", wallet.address);

await wallet.deposit({ amount: 1000n, asset: 1n });
await wallet.sync({ onProgress: (p) => console.log(p.phase, p.fetched) });
console.log("balance:", wallet.balance(1n).toString());

await wallet.transfer({ to: peerBech32, amount: 100n, asset: 1n, autoConsolidate: true });
await wallet.withdraw({ to: "0xf39…", amount: 200n, asset: 1n });
```

Three things to know:

- **Prover artifacts** auto-resolve on Node when the companion
  `@lelantos-org/circuits` package is installed (`npm install
  @lelantos-org/circuits` alongside the SDK). Browser callers must
  pass `proverArtifacts: { circuit, zkey }` to `Wallet.connect`
  explicitly — most bundlers can resolve the artifact URLs from
  `node_modules/@lelantos-org/circuits/2x2/*`. There is no built-in
  browser CDN because the companion lives on GitHub Packages, which
  jsDelivr does not proxy.
- **`autoConsolidate: true`** makes transfer/withdraw self-spend the two
  smallest notes and retry instead of throwing `InsufficientCoverError`.
- **`network: "sepolia" | "mainnet"`** are reserved placeholder presets.
  Calling them today throws `NetworkNotDeployedError` until contracts
  ship — the SDK upgrade is the only change needed once they do.

### Advanced — full-control wiring

When you need to inject every pluggable yourself (custom indexer, alt
chain library, mocked submitter), reach for `Wallet.create(source, cfg)`
which takes the explicit `WalletConfig`. The single-call `Wallet.connect`
above is built on top of it.

---

## Wallet creation

Four key sources. All produce a deterministic `nsk` field element; the
wallet keys (`ivk`, `pk`, `pk_d`, `dk`) and bech32m address derive from
it. Pick the factory that matches your call site.

### From a hex EVM private key — `Wallet.fromPrivateKey`

The newcomer path. One key both signs on-chain transactions and derives
the shielded `nsk` (via domain-separated `keccak256` reduction). Most
common for backend services and dev scripts.

```ts
const wallet = await Wallet.fromPrivateKey(
    "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
    { network: "anvil", rpcUrl: "http://localhost:8545" },
);
```

The derivation is exposed standalone as `hexPrivateKeyToNsk(hex)` for
callers that want only the field element.

### From a BIP39 mnemonic — `Wallet.fromMnemonic`

The production path for end-user wallets. The mnemonic only derives
`nsk`; on-chain signing still comes from `signer` / `privateKey` /
`chain` in the options.

```ts
import { Wallet, generateMnemonic, isValidMnemonic } from "@lelantos-org/sdk";

// Argument is `{ words: 12 | 24 }`. Default 24 words = 256 bits entropy.
const mnemonic = generateMnemonic({ words: 24 });
if (!isValidMnemonic(mnemonic)) throw new Error("bad seed");

const wallet = await Wallet.fromMnemonic(mnemonic, {
    network: "anvil",
    privateKey: "0x...",          // chain-side signer
    rpcUrl: "http://localhost:8545",
    account: 0,                    // optional ZIP-32 sub-account
});
```

### From an external signer (MetaMask / hardware wallet) — `Wallet.fromSigner`

Triggers one EIP-712 signature prompt at boot, then reuses the same
signer for on-chain transactions. After the first prompt the wallet
behaves identically to one built from a mnemonic.

```ts
import { BrowserProvider } from "ethers";

const provider = new BrowserProvider(window.ethereum);
await provider.send("eth_requestAccounts", []);
const signer = await provider.getSigner();

const wallet = await Wallet.fromSigner(signer, {
    network: "mainnet",
    rpcUrl: window.ethereum.rpcUrl,
});
```

### Power user — `Wallet.connect` and `Wallet.create`

Reach for `Wallet.connect(opts)` when you need to mix sources (e.g.
mnemonic for nsk + an external signer for chain) or override pluggables.
Reach for `Wallet.create(source, cfg)` when you need to inject every
pluggable yourself (custom indexer, alt chain library, mocked
submitter).

```ts
const wallet = await Wallet.create(
    { type: "nsk", nsk: 0xdeadbeefn },   // raw — test only
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

Pulls encrypted notes, trial-decrypts with the wallet's `ivk`, persists hits to the `NoteStore`.

#### Sync strategies

Two strategies surfaced via `WalletConfig.syncStrategy` (selects default `NoteSource` flavor; ignored if `noteSource` set directly):

| Strategy | Endpoint | FMD runs | Anonymity | Bandwidth |
|---|---|---|---|---|
| `{ kind: "full" }` (default) | `/v1/notes` (firehose) | client-side (or skipped) | max — server sees no detection key | every encrypted note |
| `{ kind: "matches", subscriptionId }` | `/v1/matches?subscription=…` | server-side via registered subscription | reduced — server learns FMD-positive subset | only false-positive subset |

```ts
// Full firehose — no FMD on server, max anonymity.
const wallet = await Wallet.connect({ ...cfg, syncStrategy: { kind: "full" } });

// Server-side FMD — register detection key once, then pull only matches.
const wallet = await Wallet.connect({ ...cfg, syncStrategy: { kind: "matches", subscriptionId: 42 } });
```

**Without FMD (no detection key)** — `scanNotes` trial-decrypts every fetched note. Highest CPU, no FMD info leak at all (clue field ignored).

**With FMD client-side** — pass a detection key to `scanNotes`/`Wallet`; clues pre-filter locally before trial-decrypt. CPU cut, server still sees nothing.

**With FMD server-side (`matches`)** — server holds detection key for the subscription, only sends false-positive subset. Lowest bandwidth + CPU, but server learns approximate recipient set (false-positive rate tunable on registration).

Pick `full` + client-FMD for max privacy on a fast link. Pick `matches` for mobile/low-bandwidth where the linkability tradeoff is acceptable.

### Inspect cache

```ts
wallet.allNotes();                                 // every asset
wallet.notes({ asset: 1n, spent: false });         // filter
wallet.balance(1n);                                // bigint, unspent only
```

`WalletNote` is the only note type integrators touch. Storage encoding
(decimal-string `bigint`s) is internal. If you need the cryptographic
fields for a custom proof — e.g. when assembling bundles via the
low-level builders — call `note.notePayload()` for `{ asset, value, rho,
rcm, rcvDep }` as native bigints.

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

## Networks

Built-in presets cover local development and reserve names for public
deployments. Unknown names throw immediately so typos surface at
`connect` time.

| Preset | chainId | Status | Notes |
|--------|---------|--------|-------|
| `anvil` | 31337 | live (local) | Foundry dev chain. |
| `localnet` | 31337 | live (local) | Alias of `anvil`. Diverges later. |
| `sepolia` | 11155111 | reserved | Throws `NetworkNotDeployedError` until contracts deploy. |
| `mainnet` | 1 | reserved | Same. |

### Custom network

When you need a network the SDK doesn't ship a preset for, pass a
`NetworkPreset` object directly in place of the name:

```ts
import { Wallet, type NetworkPreset } from "@lelantos-org/sdk";

const myChain: NetworkPreset = {
    chainId: 8453n,
    maspAddress: "0xMASP…",
    relayerAddress: "0xRelayer…",
    relayerUrl: "https://relayer.my-deployment.example",
    fmdUrl: "https://fmd.my-deployment.example",
    treeDepth: 10,
    permit2Address: "0x000000000022D473030F116dDEE9F6B43aC78BA3",  // optional
};

const wallet = await Wallet.fromPrivateKey(pk, { network: myChain, rpcUrl });
```

Set `maspAddress` or `relayerAddress` to `null` to mark the preset as a
placeholder (useful for staging deploys); `connect()` then throws
`NetworkNotDeployedError` so call sites fail loudly.

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

The companion `@lelantos-org/circuits` package ships the prover
artifacts as static `.wasm` + `.zkey` files. Resolve their URLs through
your bundler's asset pipeline and pass them to `Wallet.connect`:

```ts
// Vite / Next.js
import wasmUrl from "@lelantos-org/circuits/2x2/2x2.wasm?url";
import zkeyUrl from "@lelantos-org/circuits/2x2/2x2_final.zkey?url";

const wallet = await Wallet.connect({
    network: "mainnet",
    signer,
    rpcUrl,
    proverArtifacts: { circuit: wasmUrl, zkey: zkeyUrl },
});
```

For environments with a self-hosted asset CDN, pass the base URL via
`proverArtifactsCdn` instead of resolving each file individually.

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
- `ProverArtifactsMissingError` (`code: "PROVER_ARTIFACTS_MISSING"`) —
  no `proverArtifacts` passed, no companion `@lelantos-org/circuits`
  package installed, no `LELANTOS_PROVER_ARTIFACTS_DIR` env var. Reads
  `tried: string[]` for every resolution path attempted. Fix with any
  one of: pass `proverArtifacts`, install the companion package, set
  the env var.
- `NetworkNotDeployedError` (`code: "NETWORK_NOT_DEPLOYED"`) — preset
  was found but its on-chain addresses are still `null` (placeholder
  network). Reads `network: string`. Fix by picking a deployed preset
  or passing a custom `NetworkPreset` literal.

`HttpClientOptions` (passed via `connect({ http: { timeoutMs, retries } })`
or directly to `FmdClient` / `RelayerClient`) tunes timeout (default
30 000 ms) and retry count (default 2).
