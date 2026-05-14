# SDK Usage Guide

End-to-end walkthrough of `@lelantos-org/sdk`: create wallet, deposit, sync, balance, transfer, withdraw, plus pluggables and error handling.

See [README.md](./README.md) for installation, layout, address format, and stability guarantees.

---

## Quickstart

One EVM private key signs on-chain txs and derives shielded `nsk`:

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

- Prover artifacts auto-resolve on Node when `@lelantos-org/circuits` is installed. Browser callers pass `proverArtifacts: { circuit, zkey }` to `Wallet.connect`.
- `autoConsolidate: true` self-spends two smallest notes and retries instead of throwing `InsufficientCoverError`.
- `network: "sepolia" | "mainnet"` are placeholder presets; throw `NetworkNotDeployedError` until contracts ship.

`Wallet.create(source, cfg)` takes explicit `WalletConfig` for full pluggable control. `Wallet.connect` wraps it.

---

## Wallet creation

Four key sources. All produce a deterministic `nsk` field element. Wallet keys (`ivk`, `pk`, `pk_d`, `dk`) and bech32m address derive from it.

### `Wallet.fromPrivateKey` — hex EVM key

One key signs on-chain and derives `nsk` via domain-separated `keccak256` reduction.

```ts
const wallet = await Wallet.fromPrivateKey(
    "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
    { network: "anvil", rpcUrl: "http://localhost:8545" },
);
```

`hexPrivateKeyToNsk(hex)` exposes derivation standalone.

### `Wallet.fromMnemonic` — BIP39

Mnemonic only derives `nsk`; chain signing comes from `signer` / `privateKey` / `chain`.

```ts
import { Wallet, generateMnemonic, isValidMnemonic } from "@lelantos-org/sdk";

const mnemonic = generateMnemonic({ words: 24 });
if (!isValidMnemonic(mnemonic)) throw new Error("bad seed");

const wallet = await Wallet.fromMnemonic(mnemonic, {
    network: "anvil",
    privateKey: "0x...",
    rpcUrl: "http://localhost:8545",
    account: 0,
});
```

### `Wallet.fromSigner` — MetaMask / hardware

One EIP-712 prompt at boot; subsequent on-chain txs reuse the signer.

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

### `Wallet.connect` / `Wallet.create`

`connect(opts)` mixes sources (mnemonic nsk + external chain signer) and overrides pluggables. `create(source, cfg)` takes explicit `WalletConfig` with every pluggable injected.

```ts
const wallet = await Wallet.create(
    { type: "nsk", nsk: 0xdeadbeefn },
    config,
);
```

---

## Transactions

### Deposit (shield)

```ts
const tx = await wallet.deposit({
    amount: 1000n,            // circuit units; on-chain inAmt = value * scale
    asset: 1n,                // optional, default 1
    to: peerBech32,           // optional, default own address
    deadline: 1700000000n,    // optional permit expiry (default: now + 3600s)
});
// tx: { txHash, cm: ["0x...", "0x..."] }
```

Chain adapter signs EIP-2612 permit so deposit + ERC20 pull happen in one atomic tx (no separate `approve`). Deposit strategies (`native`, `allowance`, `witness`) picked per-asset by the adapter; `DepositAdapterError` raised on mismatch.

### Transfer (shielded → shielded)

```ts
const tx = await wallet.transfer({
    to: peerBech32,
    amount: 100n,
    asset: 1n,
    selectOpts: { dustThreshold: 10n },
    autoConsolidate: true,
});
// tx: { txHash, cm, spentNoteIds, inputSum, sent, change }
```

Auto-selects up to 2 unspent notes; change returns to self. Without `autoConsolidate`, throws `InsufficientCoverError` when no 2-note cover exists:

```ts
try {
    await wallet.transfer({ to, amount });
} catch (e) {
    // "insufficient 2-note cover for ...; consolidate two smallest notes first
    //  (ids: a, b, sum: 70), then re-run"
}
```

Manual consolidate: `wallet.transfer({ to: wallet.address, amount: smallSum })`.

### Withdraw (shielded → ERC20)

```ts
const tx = await wallet.withdraw({
    to: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
    amount: 200n,
    asset: 1n,
});
```

Change splits into two new self-notes. MASP sends `outAmt - fee` to recipient; treasury keeps `fee`.

### Withdraw ETH (shielded → native)

```ts
await wallet.withdrawEth({ to: "0xf39…", amount: 200n });
```

Unwraps WETH-shielded asset to native ETH in one tx.

### Swap

```ts
await wallet.swap({
    fromAsset: 1n,
    toAsset: 2n,
    amount: 100n,
    minOut: 95n,
});
```

Atomic shielded-to-shielded swap routed through the relayer's pool adapter.

---

## Note management

### Sync from fmd-webserver

```ts
const r = await wallet.sync({ limit: 1000 });
// { fetched, hits, added, skipped }
```

Pulls encrypted notes, trial-decrypts with wallet `ivk`, persists hits to `NoteStore`.

Related methods:
- `wallet.refresh()` — re-derive balances from store without network fetch.
- `wallet.awaitCommitments(cms, opts?)` — block until commitments appear in chain index.
- `wallet.markSpent(ids)` — mark notes spent manually (recovery flows).
- `wallet.cancelIntent(id)` — cancel pending intent.

#### Sync strategies

Two strategies via `WalletConfig.syncStrategy` (selects default `NoteSource`; ignored if `noteSource` set directly):

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

- No detection key: `scanNotes` trial-decrypts every note. Highest CPU, zero FMD leak.
- Client-side FMD: pass detection key; clues pre-filter locally. CPU cut, server sees nothing.
- Server-side FMD (`matches`): server holds detection key, returns false-positive subset. Lowest bandwidth, server learns approximate recipient set.

### Inspect cache

```ts
wallet.allNotes();                                 // every asset
wallet.notes({ asset: 1n, spent: false });         // filter
wallet.balance(1n);                                // bigint, unspent only
```

`WalletNote` is the integrator-facing type. Storage encoding (decimal-string bigints) is internal. For cryptographic fields (custom proofs / low-level builders) call `note.notePayload()` → `{ asset, value, rho, rcm, rcvDep }` as native bigints.

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

Default selector is SFRT (Smallest-First, Random Tiebreak). Avoids largest-first balance-ordering fingerprint; drains dust over time.

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

Six injection points on `WalletConfig`. Each has a default.

| Interface | Default | Use case |
|---|---|---|
| `ChainAdapter` | `EthersChainAdapter` | viem / web3.js / hardware-wallet signing |
| `NoteSource` | `FmdNoteSource` (over `FmdClient`) | alt indexer, P2P feed, unit-test mock |
| `Submitter` | `HttpRelayerSubmitter` | multi-relayer race, direct-on-chain submit, test mock |
| `Prover` | `SnarkjsProver` (in-process) | remote prover, Web Worker prover, mock |
| `CoinSelector` | `SfrtCoinSelector` | largest-first, Penumbra planner, deterministic test stub |
| `NoteStore` | `InMemoryNoteStore` | file, IndexedDB, encrypted KV |

`WalletApi` itself is an interface — mock whole wallet in upstream tests.

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

Built-in presets. Unknown names throw at `connect` time.

| Preset | chainId | Status |
|--------|---------|--------|
| `anvil` | 31337 | local |
| `localnet` | 31337 | local (anvil alias) |
| `sepolia` | 11155111 | placeholder → `NetworkNotDeployedError` |
| `mainnet` | 1 | placeholder → `NetworkNotDeployedError` |

### Custom network

Pass a `NetworkPreset` object in place of the name:

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

Set `maspAddress` or `relayerAddress` to `null` to mark preset as placeholder; `connect()` then throws `NetworkNotDeployedError`.

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

Companion `@lelantos-org/circuits` ships prover artifacts as static `.wasm` + `.zkey`. Resolve URLs via bundler asset pipeline and pass to `Wallet.connect`:

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

Self-hosted CDN: pass base URL via `proverArtifactsCdn` instead of per-file URLs.

---

## Low-level primitives

Everything `Wallet` uses internally is exported:

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

`e2e/runner` consumes these directly without `Wallet`.

---

## Errors

All typed errors inherit `WalletError` with stable `code` field. Catch `WalletError` for blanket handling; subclass for extra fields.

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

| Class | Code | Notes |
|---|---|---|
| `InsufficientCoverError` | `INSUFFICIENT_COVER` | No 1/2-note cover. Pass `autoConsolidate` or read `consolidate: StoredNote[]`. |
| `WalletConfigError` | `WALLET_CONFIG` | `missing: string[]` lists all problems. |
| `NetworkError` | `RELAYER_*` / `FMD_*` | Wraps fetch failures + timeouts. Fields: `url`, `status?`, `cause?`. HTTP clients retry 5xx + network errors twice (exp backoff). |
| `ProverError` | `PROVER_FAILED` | Proof generation failed. |
| `ProverArtifactsMissingError` | `PROVER_ARTIFACTS_MISSING` | Field `tried: string[]`. Fix: pass `proverArtifacts`, install companion, or set `LELANTOS_PROVER_ARTIFACTS_DIR`. |
| `PermitRejectedError` | `PERMIT_REJECTED` | User rejected EIP-2612 sig. |
| `DepositAdapterError` | `DEPOSIT_ADAPTER` | Strategy mismatch (`native`/`allowance`/`witness`). |
| `SelectionError` | `SELECTION_FAILED` | Coin-selector failure. |
| `TxMiningError` | `TX_MINING` | Chain tx submitted but not mined / reverted. |
| `NetworkNotDeployedError` | `NETWORK_NOT_DEPLOYED` | Field `network: string`. Pick deployed preset or pass `NetworkPreset` literal. |

`HttpClientOptions` via `connect({ http: { timeoutMs, retries } })` or directly to `FmdClient` / `RelayerClient`. Defaults: timeout 30 000 ms, retries 2.
