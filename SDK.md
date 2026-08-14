# SDK Usage Guide

End-to-end walkthrough of `@lelantos-org/sdk`: create wallet, deposit, sync, balance, transfer, withdraw, plus pluggables and error handling.

See [README.md](./README.md) for installation, layout, address format, and stability guarantees.

## Contents

1. [Quickstart](#quickstart)
2. [Wallet creation](#wallet-creation)
3. [Amounts](#amounts)
4. [Transactions](#transactions)
5. [Note management](#note-management)
6. [Custom storage](#custom-storage)
7. [Custom chain adapter](#custom-chain-adapter)
8. [Pluggable interfaces](#pluggable-interfaces)
9. [Networks](#networks)
10. [Browser usage](#browser-usage)
11. [Low-level primitives](#low-level-primitives)
12. [Paying for APIs (x402)](#paying-for-apis-x402)
13. [Errors](#errors)

---

## Quickstart

One EVM private key signs on-chain txs and derives shielded `nsk`:

```ts
import { connect, formatAmount, parseAmount } from "@lelantos-org/sdk";

const wallet = await connect({
    privateKey: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
    network: "anvil",
    rpcUrl: "http://localhost:8545",
});

console.log("address:", wallet.address);

const weth = await wallet.asset(1n);                       // { id, token, scale, symbol, decimals }
await wallet.deposit({ asset: weth.id, amount: parseAmount("0.5", weth) });
await wallet.sync({ onProgress: (p) => console.log(p.phase, p.fetched) });
console.log("balance:", formatAmount(wallet.balance(weth.id), weth, { symbol: true }));

await wallet.transfer({ to: peerBech32, amount: 100n, asset: 1n, autoConsolidate: true });
await wallet.withdraw({ to: "0xf39…", amount: 200n, asset: 1n });
```

- Prover artifacts auto-resolve on Node when `@lelantos-org/circuits` is installed. Browser callers pass `proverArtifacts: { circuit, zkey }` to `connect()`.
- `autoConsolidate: true` self-spends two smallest notes and retries instead of throwing `InsufficientCoverError`.
- `network: "sepolia" | "mainnet"` are placeholder presets; throw `NetworkNotDeployedError` until contracts ship.
- Every `amount` is in **circuit units**. See [Amounts](#amounts) before hard-coding a literal.

`Wallet.create(source, cfg)` takes explicit `WalletConfig` for full pluggable control. `connect()` wraps it.

---

## Wallet creation

Four key sources. All produce a deterministic `nsk` field element. Wallet keys (`ivk`, `pk`, `pk_d`, `dk`) and bech32m address derive from it.

### `connect({ privateKey })` — hex EVM key

One key signs on-chain and derives `nsk` via domain-separated `keccak256` reduction.

```ts
const wallet = await connect({
    privateKey: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
    network: "anvil",
    rpcUrl: "http://localhost:8545",
});
```

`hexPrivateKeyToNsk(hex)` exposes derivation standalone.

### `connect({ mnemonic })` — BIP39

Mnemonic only derives `nsk`; chain signing comes from `signer` / `privateKey` / `chain`.

```ts
import { connect, generateMnemonic, isValidMnemonic } from "@lelantos-org/sdk";

const mnemonic = generateMnemonic({ words: 24 });
if (!isValidMnemonic(mnemonic)) throw new Error("bad seed");

const wallet = await connect({
    mnemonic,
    network: "anvil",
    privateKey: "0x...",
    rpcUrl: "http://localhost:8545",
    account: 0,
});
```

### `connect({ signer })` — MetaMask / hardware

One EIP-712 prompt at boot; subsequent on-chain txs reuse the signer.

```ts
import { BrowserProvider } from "ethers";

const provider = new BrowserProvider(window.ethereum);
await provider.send("eth_requestAccounts", []);
const signer = await provider.getSigner();

const wallet = await connect({
    signer,
    network: "mainnet",
    rpcUrl: window.ethereum.rpcUrl,
});
```

### `connect()` / `Wallet.create()`

`connect(opts)` mixes sources (mnemonic nsk + external chain signer) and overrides pluggables. `create(source, cfg)` takes explicit `WalletConfig` with every pluggable injected.

```ts
const wallet = await Wallet.create(
    { type: "nsk", nsk: 0xdeadbeefn },
    config,
);
```

`ConnectOptions` is an exclusive union of one key source
(`mnemonic` | `signature` | `nsk`) and one chain layer
(`chain` | `signer` | `{ provider, address }` | `privateKey`), so invalid
combinations fail to compile instead of throwing at runtime:

```ts
await connect({ network: "anvil", mnemonic, nsk, rpcUrl });
//                                       ^^^^^^^^^^^^^ two key sources — type error
await connect({ network: "anvil", nsk, signer });
//                                            ^^^^^^ `rpcUrl` is required here
```

---

## Amounts

Three integer spaces are in play. Mixing them up is the most common
integration bug, so the SDK names them explicitly:

| Space | Example | Where it appears |
|---|---|---|
| human | `"1.5"` | what a user types |
| token | `1500000000000000000n` | ERC-20 base units (`10 ** decimals`) |
| circuit | `1500n` | **every `Wallet` method argument and result** |

`tokenUnits = circuitUnits * asset.scale`. `wallet.asset(id)` resolves
`scale` (from the MASP registry) plus `symbol`/`decimals` (from the ERC-20,
when the chain adapter implements `tokenMeta`), and caches the result:

```ts
import { formatAmount, formatUnits, parseAmount, parseUnits } from "@lelantos-org/sdk";

const weth = await wallet.asset(1n);
// → { id: 1n, token: "0xC02a…", scale: 1000000000000000n, symbol: "WETH", decimals: 18 }

parseAmount("0.25", weth);                       // 250n     — human  → circuit
formatAmount(250n, weth, { symbol: true });      // "0.25 WETH" — circuit → human
minAmount(weth);                                 // "0.001"  — smallest expressible amount
```

`parseAmount` throws rather than truncating when a value is finer-grained
than one circuit unit. The asset-free primitives (`parseUnits`,
`formatUnits`, `toCircuitUnits`, `toTokenUnits`) are also exported from
`@lelantos-org/sdk/units` if you want them without a wallet.

---

## Transactions

### Deposit (shield)

```ts
const tx = await wallet.deposit({
    amount: 1000n,            // circuit units; on-chain inAmt = amount * scale
    asset: 1n,                // optional, default 1
    to: peerBech32,           // optional, default own address
    deadline: 1700000000n,    // optional permit expiry (default: now + 3600s)
    asEth: false,             // optional; true routes native ETH via NativeAdapter
    onPhase: (p) => console.log(p),   // "signing" | "submitting" | "broadcast" | "mined"
});
// DepositResult: { kind: "deposit", txHash, strategy, commitments,
//                  nonZeroCommitments, ownCommitments, ownInflow, sent, depositId? }
```

Each method returns its own receipt type — `deposit()` gives you a
`DepositResult`, not the four-way `TransactionResult` union — so
`tx.depositId` needs no narrowing.

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
// TransferResult: { kind: "transfer", txHash, commitments, nonZeroCommitments,
//                   ownCommitments, ownInflow, spent, inputSum, sent, change }
```

Auto-selects up to 2 unspent notes; change returns to self. Without `autoConsolidate`, throws `InsufficientCoverError` when no 2-note cover exists:

```ts
import { isWalletError } from "@lelantos-org/sdk";

try {
    await wallet.transfer({ to, amount });
} catch (e) {
    if (isWalletError(e, "INSUFFICIENT_COVER")) {
        // `e.consolidate` / `e.consolidateSum` are typed here — no `instanceof`.
        console.log("consolidate first:", e.consolidate.map((n) => n.id), e.consolidateSum);
    } else throw e;
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
import { fetchSwapQuote } from "@lelantos-org/sdk";

const quote = await fetchSwapQuote(quoterUrl, { tokenIn, tokenOut, amountIn, slippageBps: 50 });

await wallet.swap({
    assetIn: 1n,
    assetOut: 2n,
    amount: 100n,             // gross publicOut in circuit units of `assetIn`
    quote,                    // pins route + minOut
    wrapperAddress: "0xSwapWrapper…",
    bRecipient: peerBech32,   // optional, default own address
});
```

Atomic shielded-to-shielded swap: leg-1 unshields to `SwapWrapper`, leg-2
re-shields the output note. Both legs are bundled through
`submitter.submitSwap`.

---

## Note management

### Sync from fmd-webserver

```ts
const r = await wallet.sync({ limit: 1000 });
// { fetched, hits, added, skipped }
```

Pulls encrypted notes, trial-decrypts with wallet `ivk`, persists hits to `NoteStore`.

`sync()` pulls notes, the Merkle tree, and the spent-nullifier set in parallel,
then reconciles which local notes have been spent. Split them when you only
need one: `syncNotes()` is enough for a balance display, `syncTree()` is
required before spending, and `syncNullifiers()` refreshes the local spent set.

The spent set is mirrored in full rather than queried per nullifier — asking
the server "is nullifier N spent?" would name a note you own. Pass
`nullifierPersistence` (alongside `treePersistence`) to keep both mirrors
across page loads.

Related methods:
- `wallet.refresh()` — re-derive balances from store without network fetch.
- `wallet.awaitCommitments(cms, opts?)` — block until commitments appear in chain index.
- `wallet.markSpent(ids)` — mark notes spent manually (recovery flows).
- `wallet.compact()` — drop spent notes from the store; returns `{ removed }`.
- `wallet.cancelDeposit(id, inputs)` — reclaim an escrowed deposit the relayer never
  flushed, once `chain.cancelDelay()` blocks have passed. The contract stores only
  `keccak(request)` per escrow, so `inputs` (`CancelDepositInputs`) carries back every
  field it checks against that digest — `publicIn`, `cm`, `cvDep`, `publicAssetId`,
  `feeBpsAtSubmit`, `payer` and `submittedAt`. All of them come off the
  `DepositEscrowed` log, so cache it: `escrowed(id)` returns the digest alone.
  A native-ETH deposit is escrowed by `NativeAdapter`, which owns the refund
  record, so those cancel through `chain.cancelDepositNative` instead.

#### Sync strategies

Two strategies via `WalletConfig.syncStrategy` (selects default `NoteSource`; ignored if `noteSource` set directly):

| Strategy | Endpoint | FMD runs | Anonymity | Bandwidth |
|---|---|---|---|---|
| `{ kind: "full" }` (default) | `/v1/notes` (firehose) | client-side (or skipped) | max — server sees no detection key | every encrypted note |
| `{ kind: "matches", token }` | `/v1/matches?token=…` | server-side via registered subscription | reduced — server learns FMD-positive subset | only false-positive subset |

```ts
// Full firehose — no FMD on server, max anonymity.
const wallet = await connect({ ...cfg, syncStrategy: { kind: "full" } });

// Server-side FMD — register a detection key under a token you derive.
// `epoch` is 0 until you rotate; see below for why you must store it after that.
const epoch = BigInt(myAppConfig.subscriptionEpoch ?? 0);
const tokenHex = subscriptionTokenToHex(deriveSubscriptionToken(P, keys.ivk, epoch));
const fmd = new FmdClient(fmdUrl, chainId);
await fmd.createSubscription({ detectionKeyHex, gamma: 8, tokenHex });
const wallet = await connect({ ...cfg, syncStrategy: { kind: "matches", token: tokenHex } });
```

The capability token is client-chosen, so at the default epoch there is nothing
extra to persist: `deriveSubscriptionToken(P, ivk)` regenerates it from a secret
the wallet already holds, and re-registering re-attaches to the same
subscription (`created: false`) instead of duplicating it and re-running the
backfill.

Derive it from `ivk`, never from `dk` or the detection key — the γ detection
scalars are a counter stream off the address's `dk`, so both are recoverable by
senders and by the server, and a token built from either would be forgeable.

#### Rotating a subscription token

Pass `epoch` to rotate: the token travels in the `/v1/matches` query string,
which proxies and browser history record, so a leak needs a recovery path.

**Once `epoch` is non-zero, your application must persist it.** It cannot be
recovered from the server. There is no read-only subscription lookup — that
would be an existence oracle for tokens — and `POST /v1/subscriptions` creates
on miss, so probing for your current epoch is a *write* that fails both ways:
it either re-attaches to the token you were rotating away from, or recreates
one the rotation deleted, silently undoing it.

Store the **epoch**, not the token. The epoch is a non-secret integer; the token
is a bearer credential sent on every poll, and is strictly worse to leave
sitting in application storage. Keep it as a plain number and pass `BigInt(n)` —
`JSON.stringify` throws on bigint.

Losing a non-zero epoch does not lose the wallet: register a fresh one and the
indexer backfills. It costs a full re-backfill, and it strands the previous
subscription, which can no longer be deleted because its token is unrecoverable.

`gamma` sets the false-positive rate at `2^-gamma`. It must be in
`GAMMA_MIN..GAMMA_MAX` (1..16), and the server caps it further against the
current note count so a match set always keeps enough decoys — a `gamma` that
is too high is rejected with the applicable ceiling. `detectionKeyHex` must be
exactly `gamma * 32` bytes, and `tokenHex` exactly 32 bytes.

- No detection key: `scanNotes` trial-decrypts every note. Highest CPU, zero FMD leak.
- Client-side FMD: pass detection key; clues pre-filter locally. CPU cut, server sees nothing.
- Server-side FMD (`matches`): server holds detection key, returns false-positive subset. Lowest bandwidth, server learns approximate recipient set.

### Inspect cache

```ts
wallet.notes();                                    // every note, every asset
wallet.notes({ asset: 1n, spent: false });         // filter — both fields optional
wallet.balance(1n);                                // bigint, unspent only
wallet.balances();                                 // Map<assetId, bigint>, unspent only
```

`allNotes()` still works but is deprecated: `notes()` now takes an optional
filter and reads across every asset when `asset` is omitted.

`WalletNote` is the integrator-facing type. Storage encoding (decimal-string bigints) is internal. For cryptographic fields (custom proofs / low-level builders) call `note.notePayload()` → `{ asset, value, rho, rcm, rcvDep }` as native bigints.

### Select notes manually

```ts
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

`ViemChainAdapter` ships in the SDK. To use ethers / web3.js / a hardware wallet, implement `ChainAdapter`:

```ts
import { type ChainAdapter, type AssetEntry } from "@lelantos-org/sdk";

class EthersChainAdapter implements ChainAdapter {
    async chainId(): Promise<bigint> { ... }
    async payerAddress(): Promise<string> { ... }
    async fetchAsset(id: bigint): Promise<AssetEntry> { ... }
    async fetchFeeBps(): Promise<bigint> { ... }
    async maspAddress(): Promise<string> { ... }
    async signPermit2(args: Permit2SignArgs) {
        // Drive your signer (ethers, viem, hardware wallet) to produce the
        // Permit2 witness signature bound to `args.piHash`.
    }
}
```

---

## Pluggable interfaces

Nine injection points on `WalletConfig`. `chain` is required; the rest default.

| Interface | Default | Use case |
|---|---|---|
| `ChainAdapter` | — (required) | ethers / web3.js / hardware-wallet signing |
| `NoteSource` | `FmdNoteSource` (over `FmdClient`) | alt indexer, P2P feed, unit-test mock |
| `NoteStore` | `InMemoryNoteStore` | file, IndexedDB, encrypted KV |
| `TreeStore` | built from the commitment chunk feed | pre-seeded tree, shared cache |
| `NullifierStore` | built from the nullifier chunk feed | pre-seeded spent set, shared cache |
| `Submitter` | `HttpRelayerSubmitter` | multi-relayer race, direct-on-chain submit, test mock |
| `Prover` | `WasmProver` (snarkjs fallback; `useWasmProver: false` opts out) | remote prover, Web Worker prover, mock |
| `CoinSelector` | `SfrtCoinSelector` | largest-first, Penumbra planner, deterministic test stub |
| `Scanner` | `LocalScanner` | `WorkerPoolScanner` for off-main-thread trial decryption |

`TreeStore` and `NullifierStore` are usually configured through
`treePersistence` / `nullifierPersistence` rather than replaced outright.

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

A `NoteSource` only supplies the encrypted-note feed. Merkle paths come from
`TreeStore` and the spent set from `NullifierStore`, both built locally from
chunk feeds — neither is a per-item server query, because asking for one path
or one nullifier names the note you are about to spend.

```ts
import { type NoteSource, type ScanInput } from "@lelantos-org/sdk";

class IndexerNoteSource implements NoteSource {
    async listNotes(opts): Promise<ScanInput[]> { /* fetch from your indexer */ }
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

const wallet = await connect({ privateKey: pk, network: myChain, rpcUrl });
```

Set `maspAddress` or `relayerAddress` to `null` to mark preset as placeholder; `connect()` then throws `NetworkNotDeployedError`.

---

## Browser usage

```ts
import { Wallet, ViemChainAdapter, Eip1193Signer, InMemoryNoteStore } from "@lelantos-org/sdk";

// Wrap the EIP-1193 provider exposed by MetaMask (or any injected wallet).
await window.ethereum.request({ method: "eth_requestAccounts" });
const signer = new Eip1193Signer(window.ethereum);

const wallet = await Wallet.create(
    { type: "mnemonic", mnemonic },
    {
        ...config,
        chain: new ViemChainAdapter({
            rpcUrl: "...",
            signer,                  // any EthSigner (Eip1193Signer / PrivateKeySigner / custom)
            maspAddress: "0x...",
        }),
    },
);
```

Companion `@lelantos-org/circuits` ships prover artifacts as static `.wasm` + `.zkey`. Resolve URLs via bundler asset pipeline and pass to `connect()`:

```ts
// Vite / Next.js
import wasmUrl from "@lelantos-org/circuits/2x2/2x2.wasm?url";
import zkeyUrl from "@lelantos-org/circuits/2x2/2x2_final.zkey?url";

const wallet = await connect({
    network: "mainnet",
    signer,
    rpcUrl,
    proverArtifacts: { circuit: wasmUrl, zkey: zkeyUrl },
});
```

Self-hosted CDN: pass base URL via `proverArtifactsCdn` instead of per-file URLs.

### Prover performance in the browser

- The WASM prover is the default. It parses the zkey once per session and reuses it across proofs; snarkjs is the automatic fallback when the wasm module cannot load.
- Multi-threaded proving requires cross-origin isolation (`COOP: same-origin` + `COEP: require-corp`). Without it the SDK routes to snarkjs, which benches faster than single-threaded wasm.
- `prove()` blocks its calling thread even with rayon workers. For a responsive UI, run proving in a dedicated Web Worker via `browserWorkerProver`:

```ts
import { browserWorkerProver } from "@lelantos-org/sdk";

const prover = browserWorkerProver({
    workerUrl: new URL("@lelantos-org/sdk/prover-worker", import.meta.url),
    paths: { circuit: wasmUrl, zkey: zkeyUrl },
});
const wallet = await connect({ network: "mainnet", signer, rpcUrl, prover });
```

- `connect()` starts the zkey fetch + parse in the background by default (`proverWarmup: "eager"`), so the first transaction skips the multi-second setup.

#### Where the time goes

`prove()` splits into witness generation and the Groth16 proof. Both are logged at `debug` on `lelantos:prover:wasm`; `npm run test:bench` prints them. Measured on a 16-core Mac (Node), warm:

| shape | witness | groth16 | total |
|---|---|---|---|
| 2x2 | 177 ms | 560 ms | ~740 ms |
| 3x3 | 259 ms | 665 ms | ~925 ms |

Witness generation is single-threaded and unaffected by thread count. Groth16 is the part rayon parallelises — 3x3 on the same machine:

| threads | 4 | 8 | 16 |
|---|---|---|---|
| groth16 | 1288 ms | 774 ms | 665 ms |

Returns fall off sharply past 8 but have not vanished by 16, which is why the pool is not clamped low. Override with `configureProverThreads(n)`, `LELANTOS_PROVER_THREADS`, or `threads` on `WorkerProver`.

#### Artifact caching

The default shape is 3x3, whose zkey is ~49 MB. Downloaded artifacts are persisted to the **Cache API** automatically in any browser that has it — nothing to configure. Because the Cache API is origin-scoped rather than per-realm, this covers both a page reload and the prover worker, which previously re-downloaded everything the main thread had already fetched.

The URL is the cache key, so **serve new proving keys under a new path**. There is no revalidation request — a round-trip on every load would defeat the point.

```ts
import { requestPersistentStorage } from "@lelantos-org/sdk";
import { clearArtifactCache, configureArtifactCache } from "@lelantos-org/sdk/prover";

// Recommended once at startup: WebKit evicts Cache API storage after ~7 days
// without a visit, which silently restores the cold start. This covers every
// store the origin owns, so a persisted note or tree store benefits too.
await requestPersistentStorage();

await clearArtifactCache();        // reclaim ~85 MB, or force a re-download
configureArtifactCache(false);     // opt out entirely
configureArtifactCache(myCache);   // or store them in IndexedDB / OPFS / disk
```

A custom cache implements `ArtifactCache` — `get(url)` and `put(url, bytes)`, neither of which may throw. A storage failure always degrades to a network fetch, never to a failed proof.

**A Web Worker is a separate module realm**, so `configureArtifactCache` on the main thread does not reach a `WorkerProver`. The plain opt-out travels over the RPC alongside `threads`; a live `ArtifactCache` object cannot, so install a custom one inside the worker.

```ts
browserWorkerProver({ workerUrl, paths, cacheArtifacts: false });
```

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
    buildDeposit, buildSpend,
    RelayerClient,
    prove, verify,
} from "@lelantos-org/sdk";
```

`buildSpend` covers transfer, withdraw and swap — they differ only in their
public inputs, so there is one builder rather than three. Prover configuration
(`configureProverWasm`, `configureProverThreads`) lives on
`@lelantos-org/sdk/prover`.

`e2e/runner` consumes these directly without `Wallet`.

Circuit-encoding and note-store-format helpers (`toCircomInput`,
`dummyInputAt`, `auxDigest`, `hornerEval`, `encodeNotePayload`,
`encodeStoredNote`, …) moved off the root barrel to
`@lelantos-org/sdk/internal`. They track the circuit and the on-disk note
format rather than the wallet API, so they can move in any release:

```ts
import { toCircomInput, auxDigest } from "@lelantos-org/sdk/internal";
```

These primitives are pinned to the circuits release named in
`peerDependencies` by golden vectors published in that package.
`src/circuit/vectors.test.ts` reads them from the installed
`@lelantos-org/circuits` (same exact version, also a devDependency) and checks
tags, key derivation, note commitments, nullifiers, `rho`, value commitments,
leaf hashing, the Merkle tree, FMD clues, and the PolyEval public-input layout
for both the deployed 2×2 shape and the not-yet-deployed 3×3 one. Their `y`
values come from witnesses the compiled circuit produced, so a mismatch means
the SDK would build a witness the on-chain verifier rejects.

The package lives on GitHub Packages, so `npm install` needs `NODE_AUTH_TOKEN`
set to a token with `read:packages` (see `.npmrc`).

---

## Paying for APIs (x402)

[x402](https://docs.x402.org) is the HTTP-402 standard for machine payments:
a server answers `402` with what it wants, the client attaches a signed
payment, the server serves. `@lelantos-org/sdk/x402` makes a wallet a valid
payer, so an agent can buy API calls without a human in the loop.

```ts
import { connect } from "@lelantos-org/sdk";
import { x402 }    from "@lelantos-org/sdk/x402";

const wallet = await connect({ mnemonic, network: "anvil" });
await wallet.sync();

const pay  = x402(wallet, { budget: { total: "5" } });
const data = await pay("https://api.example.com/premium").then((r) => r.json());
```

`pay` is an ordinary `fetch`, which is the whole integration story — every
agent framework already takes one:

```ts
createOpenAI({ fetch: pay });                             // Vercel AI SDK
new StreamableHTTPClientTransport(url, { fetch: pay });    // MCP
```

`budget` is required. An agent that can spend without a ceiling is a footgun,
so there is no default. Limits are human decimal strings applied **per
asset** — `{ total: "5" }` means five of each asset paid, not five across all
of them, because assets are not comparable without a price oracle. Read
`pay.spent()` for the running totals.

```ts
const pay = x402(wallet, {
    budget:     { total: "5", perRequest: "0.10" },
    allowHosts: ["api.example.com"],
    onPayment:  (r) => audit.log(r),
});
```

### What gets paid, and how private it is

Payments are **shielded by default**, on the `shielded:<chainId>` network
family specified in [`docs/x402-shielded-network.md`](docs/x402-shielded-network.md).
This is not a new x402 scheme — it is `scheme: "exact"` on a new network,
the same way Solana and Stellar extended `exact`. The settlement chain sees
that a pool transaction happened; who paid whom, and how much, it does not.

Servers that only speak standard EVM `exact` can also be paid, by unshielding
into a deterministic throwaway address and signing an EIP-3009
authorization. That is `allowUnshielded: true`, **off by default** — it moves
value into the clear, and the resulting address is unlinkable to your own
account but not to itself across calls.

```ts
const pay = x402(wallet, { budget: { total: "5" }, allowUnshielded: true });
```

When a server offers both, the shielded option wins regardless of its
position in `accepts[]`. An offer this wallet cannot satisfy — wrong chain,
unknown token, a window too short to generate a proof in — is skipped in
favour of the next one; a budget breach is not, because that is your answer,
not a routing problem.

Today the unshielded path only works where the pool is deployed *and* the
token supports EIP-3009. There is no bridging: if a server wants USDC on Base
and your pool is elsewhere, the offer is refused rather than silently
becoming something else.

### Trade-offs worth knowing

- **Payment is upfront.** The transfer is submitted before the resource is
  served, so a malicious server can take payment and not answer. This is
  x402's `paymentFlow: "upfront"`, and it is why `budget` is required. The
  more trust-minimal `authorization` flow needs a facilitator that can relay
  a Lelantos bundle; when one exists it drops in without an API change.
- **A shielded payment costs a Groth16 proof** — seconds, not milliseconds.
  Offers with a `maxTimeoutSeconds` under 20 are refused by default
  (`shielded: { minTimeoutSeconds }` to change it), since paying into a
  closed window just loses the money.
- **A payment is attached to at most one retry.** If the paid request comes
  back 402 again you get `X402PaymentError` with reason `payment-rejected`,
  never a second payment. The wrapper deliberately sits outside the SDK's own
  5xx retry loop for the same reason.

### Using it with `@x402/core`

`x402()` implements the 402 loop itself so the one-liner needs no extra
install. If you already run an `x402Client` — to combine Lelantos with
Solana, or to use `@x402/mcp` — register the mechanisms directly instead.
Both are structurally `@x402/core`'s `SchemeNetworkClient`:

```ts
import { shieldedExact, shieldedNetwork, unshieldedExact } from "@lelantos-org/sdk/x402";

const chainId = await wallet.chain.chainId();
client.register(shieldedNetwork(chainId), shieldedExact(wallet));
client.register(`eip155:${chainId}`,      unshieldedExact(wallet));
```

Nothing from `@x402/*` is imported by this SDK, so neither package is needed
to build, test, or use it.

---

## Errors

Every typed error inherits `WalletError` and carries a stable `code`.
`isWalletError(err, code?)` is the guard to reach for: it narrows to the
concrete class, so the variant's context fields are typed without an
`instanceof` chain. It is duck-typed, so it keeps working when two copies
of the SDK end up in one bundle.

```ts
import { isWalletError } from "@lelantos-org/sdk";

try {
    await wallet.transfer({ to, amount });
} catch (e) {
    if (isWalletError(e, "INSUFFICIENT_COVER")) {
        await wallet.transfer({ to, amount, autoConsolidate: true });
    } else if (isWalletError(e)) {
        switch (e.code) {
            case "RELAYER_TIMEOUT": ...   // e.url, e.status
            case "PROVER_FAILED":   ...
            case "PERMIT_REJECTED": ...
            case "WALLET_CONFIG":   ...   // e.missing
            default: throw e;
        }
    } else throw e;
}
```

`WALLET_ERROR_CODES` is the runtime list of every code; `AnyWalletError` is
the union of every class, discriminated on `code`.

| Class | Code | Notes |
|---|---|---|
| `InsufficientCoverError` | `INSUFFICIENT_COVER` | No 1/2-note cover. Pass `autoConsolidate` or read `consolidate: StoredNote[]`. |
| `WalletConfigError` | `WALLET_CONFIG` | `missing: string[]` lists all problems. |
| `NetworkError` | `RELAYER_*` / `FMD_*` | Wraps fetch failures + timeouts. Fields: `url`, `status?`, `cause?`. HTTP clients retry 5xx + network errors twice (exp backoff). |
| `ProverError` | `PROVER_FAILED` | Proof generation failed. |
| `ProverArtifactsMissingError` | `PROVER_ARTIFACTS_MISSING` | Field `tried: string[]`. Fix: pass `proverArtifacts`, install companion, or set `LELANTOS_PROVER_ARTIFACTS_DIR`. |
| `PermitRejectedError` | `PERMIT_REJECTED` | User rejected EIP-2612 sig. |
| `DepositAdapterError` | `DEPOSIT_ADAPTER` | Strategy mismatch (`native`/`allowance`/`witness`). |
| `SelectionError` | `SELECTION` | Coin-selector failure. Field `asset?`. |
| `TxMiningError` | `TX_MINING` | Chain tx submitted but not mined / reverted. |
| `NetworkNotDeployedError` | `NETWORK_NOT_DEPLOYED` | Field `network: string`. Pick deployed preset or pass `NetworkPreset` literal. |
| `X402PaymentError` | `X402_PAYMENT` | Field `reason`: `budget-exceeded`, `per-request-limit`, `host-not-allowed`, `no-acceptable-requirements`, `unsupported-requirements`, `payment-rejected`. Every reason except `payment-rejected` means no funds moved. |

`HttpClientOptions` (`{ timeoutMs, retries }`) is passed to `FmdClient` or
`RelayerClient` at construction; inject the configured client through
`noteSource` / `submitter` to change it. Defaults: timeout 30 000 ms, retries 2.
