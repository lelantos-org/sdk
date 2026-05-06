# SDK Usage Guide

End-to-end walkthrough of `@lelantos-org/sdk`: create wallet, deposit, sync, balance, transfer, withdraw, plus pluggables and error handling.

See [README.md](./README.md) for installation, layout, address format, and stability guarantees.

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
