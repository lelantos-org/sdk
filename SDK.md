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
- `mainnet`, `base` and `arbitrum` are deployed; `sepolia` is still a placeholder and throws `NetworkNotDeployedError`.
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

<!-- typecheck: skip -->
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

<!-- typecheck: skip -->
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
import { formatAmount, formatUnits, minAmount, parseAmount, parseUnits } from "@lelantos-org/sdk";

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

#### Waiting for the relayer to settle a deposit

A mined deposit is escrowed, not yet in the tree — the relayer folds it in
with `flushBatch`, and publishes that on an SSE feed. `depositId` from the
receipt is the correlation key.

```ts
import { DepositStream } from "@lelantos-org/sdk/relayer";

const stream = new DepositStream(relayerUrl, chainId);
const tx = await wallet.deposit({ amount: 1000n });
if (tx.depositId !== undefined) {
    const wait = await stream.awaitFlush(tx.depositId, { signal });
    if (wait.kind === "flushed") console.log("settled in", wait.txHash, wait.blockNumber);
}
stream.close();
```

Open the stream *before* depositing. The relayer does not replay, so a fast
flush can land before you subscribe; the stream buffers recent events and
`awaitFlush` matches them, which closes that race. The buffer holds the last
64 events — raise `replayBuffer` on a busy chain, where 64 flushes can go by
between broadcasting and awaiting.

`EventSource` is a browser global with no Node equivalent, so outside the
browser pass one — the constructor throws `EnvironmentError` when there is no
global to fall back to:

```ts
import { DepositStream } from "@lelantos-org/sdk/relayer";

const stream = new DepositStream(relayerUrl, chainId, {
    eventSourceFactory: (src) => new MyEventSourcePolyfill(src),
});
```

`awaitFlush` never rejects. It resolves a `FlushWait`, discriminated on `kind`:
the settlement event itself, `{ kind: "aborted" }` if the signal fired, or
`{ kind: "closed" }` if the feed died. The success arm *is* the event, so a
narrowed `wait` reads `wait.txHash` directly. The other two mean settlement
went unobserved, not that the deposit failed — the tx is already mined either
way.

`wait.txHash` is the relayer's `flushBatch` tx, **not** your deposit tx — they
are different transactions in different blocks, so `wait.blockNumber` is when
the note entered the tree, not when your deposit was mined. Keep
`tx.txHash` from the `DepositResult` if you need to link back to the deposit
itself.

### Watching every deposit

`awaitFlush` is one deposit; `subscribe` is the whole feed — for a UI that
reconciles several in flight, or an indexer that mirrors them.

```ts
import { DepositStream, type RelayerDepositEvent } from "@lelantos-org/sdk/relayer";

const stream = new DepositStream(relayerUrl, chainId, { replayBuffer: 256 });

const unsubscribe = stream.subscribe((ev: RelayerDepositEvent) => {
    if (ev.kind === "flushed") console.log("settled", ev.depositId, ev.txHash);
});

// Later — drop this listener without tearing down the shared stream.
unsubscribe();

// A fatal transport error closes the feed without any call to `close()`.
if (stream.isClosed) console.log("feed gone; construct a new DepositStream");
```

`subscribe` only sees events from now on — it does not read the replay buffer,
unlike `awaitFlush`. Register it before the deposits you care about.

`isClosed` is how you tell a stream you closed from one the transport killed.
Pending `awaitFlush` calls settle as `{ kind: "closed" }` in both cases, so
without checking it a reconnect loop cannot tell "the wallet went away" from
"the relayer went away". The stream does not reopen itself once closed;
construct a new one.

`RelayerDepositEvent` is a union with one member today (`DepositFlushed`) and
the relayer may add variants, so narrow on `kind` rather than assuming
`flushed`. Unrecognised frames are logged and dropped, never thrown — one bad
event must not tear down a feed another waiter depends on.

A transient disconnect is not a close — the browser reconnects and the stream
keeps waiting. Only a fatal error (`readyState === CLOSED`, which is what an
HTTP error status produces) settles waiters, rather than leaving them to wait
out a caller-side timeout against a source that is gone.

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
//                   ownCommitments, ownInflow, recipientCommitment, spent,
//                   inputSum, sent, change }
```

Output slots are shuffled, so read `recipientCommitment` for the payee's note
rather than indexing `commitments`.

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
await wallet.withdrawEth({ to: "0xf39…", amount: 200n, asset: 1n });
```

Unwraps WETH-shielded asset to native ETH in one tx.

### Swap

```ts
import { fetchSwapQuote } from "@lelantos-org/sdk/quoter";

const quote = await fetchSwapQuote(quoterUrl, {
    chainId,
    tokenIn,
    tokenOut,
    amountIn,
    slippageBps: 50,
});

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

#### What the swap actually credits

The re-shielded B-note is **not** `quote.minOut / scaleOut`, and it is not a
floor either. `swap()` sizes it with `sizeBNote` and encodes that exact value as
the deposit leg's `publicIn`, so it is what the wallet receives — the wrapper
pulls only what the note needs, and any better-than-quoted fill goes to the
treasury as dust. Show this figure, not `expectedOut`:

```ts
import { sizeBNote } from "@lelantos-org/sdk/wallet";

const feeBps = await chain.fetchFeeBps();
const { scale } = await chain.fetchAsset(asset);
const credited = sizeBNote(quote.minOut, scale, feeBps);
```

Do not re-derive it. The obvious closed form —
`minOut * BPS / (scale * (BPS + feeBps))` — is only the lower bound the search
starts from, and lands *below* `minOut` whenever the division is inexact: wrong
on screen, and reverting on chain if used to size a transaction.

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

#### Polling for new activity

`sync()` is expensive — it pages the note feed, folds the tree and mirrors the
spent set. `FmdClient.fetchHead()` is the cheap question that says whether any
of that is worth doing: two indexed `MAX()`s, uncached on both sides, small
enough to poll every few seconds.

```ts
import { FmdClient } from "@lelantos-org/sdk/fmd-server";

const fmd = new FmdClient(fmdUrl, chainId);
let lastSeen: string | undefined;

const head = await fmd.fetchHead();
// { chainId, maxNoteId, maxNullifierSeq }

const token = `${head.maxNoteId}:${head.maxNullifierSeq}`;
if (token !== lastSeen) {
    lastSeen = token;
    await wallet.sync();
}
```

Both fields are **monotonic row cursors scoped to one chain**, not counts and
not block heights:

- `maxNoteId` is the newest indexed note. It moves when a note arrives, and it
  is exactly the cursor the note feed pages from.
- `maxNullifierSeq` is the newest observed spend. It moves when *anyone* spends,
  which is what makes a note of yours turn out to be already spent.

Compare them to what you last saw and skip the expensive reads when neither
moved. `0` means "nothing yet" and is a valid starting value — an empty chain
answers `200` with zeros rather than 404, so the comparison works before the
chain has any history.

Two things it deliberately does not cover. It carries **no tree watermark** —
no `leafCount`, no root — so there is nothing here to gate `syncTree()` on;
`fetchTreeState()` is what reports those. And it is per-chain: a multi-chain
client polls it once per chain id, because a shared counter would make one
chain's activity trigger syncs on every other.

Requires an fmd-webserver new enough to serve `/v1/head`; an older one answers
404 and `fetchHead` throws, so treat a failure as "poll again later" and keep
whatever slower interval you had rather than treating it as no activity.

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
| `{ kind: "full" }` (default) | `/v1/notes` (firehose) | skipped | max — no detection key leaves the wallet | every encrypted note |
| `{ kind: "matches", token }` | `/v1/matches` (token in `Authorization`) | server-side via registered subscription | reduced — server learns the FMD-positive subset, and holds your detection capability permanently | only false-positive subset |

```ts
import { detectionKey } from "@lelantos-org/sdk";
import { cryptoContext, deriveSubscriptionToken } from "@lelantos-org/sdk/crypto";
import { FMD_SENDER_GAMMA, detectionKeyToHex, subscriptionTokenToHex } from "@lelantos-org/sdk/fmd";
import { FmdClient } from "@lelantos-org/sdk/fmd-server";

// Full firehose — no FMD on the server, maximum anonymity.
const full = await connect({ privateKey: pk, network: "anvil", rpcUrl });

// Server-side FMD — register a detection key under a token you derive.
// `epoch` is 0 until you rotate; see below for why it must be stored after that.
const { P } = await cryptoContext();
const epoch = BigInt(myAppConfig.subscriptionEpoch ?? 0);
const tokenHex = subscriptionTokenToHex(deriveSubscriptionToken(P, keys.ivk, epoch));
const detectionKeyHex = detectionKeyToHex(await detectionKey(viewingKey, FMD_SENDER_GAMMA));

const fmd = new FmdClient(fmdUrl, chainId);
await fmd.createSubscription({ detectionKeyHex, gamma: FMD_SENDER_GAMMA, tokenHex });

const matches = await connect({
    privateKey: pk,
    network: "anvil",
    rpcUrl,
    syncStrategy: { kind: "matches", token: tokenHex },
});
```

Delegating detection is one-way. The scalars you POST are `x_i = dk + h_i` over
a publicly computable `h_i`, so the server recovers your root FMD secret `dk`
and keeps the ability to detect your incoming notes at any γ, forever. Rotating
the subscription token does not revoke it; only a new `nsk` does. `full` is the
default for this reason.

The capability token is client-chosen, so at the default epoch there is nothing
extra to persist: `deriveSubscriptionToken(P, ivk)` regenerates it from a secret
the wallet already holds, and re-registering re-attaches to the same
subscription (`created: false`) instead of duplicating it and re-running the
backfill.

Derive it from `ivk`, never from `dk` or the detection key. The γ detection
scalars are `x_i = dk + h_i` over an `h_i` anyone can compute from the public
`ck`, so the server you hand them to can invert back to `dk` — a token built
from either would be forgeable by that server.

#### Rotating a subscription token

Pass `epoch` to rotate. The token is a bearer credential sent on every poll,
derived from `ivk` and therefore stable across sessions, machines and IPs — a
pseudonymous identifier for the wallet. It travels in an `Authorization`
header, which keeps it out of proxy and browser-history logs, but a credential
with no rotation path has no recovery from a leak by any other route.

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

`gamma` sets the false-positive rate at `2^-gamma`, and **`FMD_SENDER_GAMMA`
is its ceiling** — not `GAMMA_MAX`. Senders pack exactly `FMD_SENDER_GAMMA`
clue bits into the 16-bit on-chain field and leave the rest zero, while
detection tests every bit of the key. A key longer than that tests trailing
bits against zero padding, each passing only when your own shared bit happens
to be 1, so it drops roughly `1 - 2^-(gamma - FMD_SENDER_GAMMA)` of *your own*
notes instead of admitting more decoys. `detectionKey` and `createSubscription`
both reject it. Raising the sender γ is a circuits change, not an SDK one.

The server caps `gamma` further against the current note count so a match set
always keeps enough decoys — a `gamma` that is too high is rejected with the
applicable ceiling. `detectionKeyHex` must be exactly `gamma * 32` bytes, and
`tokenHex` exactly 32 bytes.

- No detection key (`full`, the default): `scanNotes` trial-decrypts every note. Highest CPU, zero FMD leak.
- Server-side FMD (`matches`): server holds the detection key, returns the false-positive subset. Lowest bandwidth, server learns your approximate recipient set — and, because `x_i = dk + h_i` inverts, your root detection secret for good.

There is no client-side FMD pre-filter. The note feed does not carry `clue.R`,
so one is not implementable today — see `sync/scanner.ts`.

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
        const json = ((await idbGet("lelantos-notes")) as string | undefined) ?? '{"version":2,"notes":[]}';
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

<!-- typecheck: skip -->
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
| `Prover` | `WasmProver` (snarkjs fallback; `useWasmProver: false` opts out) | Web Worker prover, mock |
| `CoinSelector` | `SfrtCoinSelector` | largest-first, Penumbra planner, deterministic test stub |
| `Scanner` | `LocalScanner` | `WorkerPoolScanner` for off-main-thread trial decryption |

`TreeStore` and `NullifierStore` are usually configured through
`treePersistence` / `nullifierPersistence` rather than replaced outright.

`WalletApi` itself is an interface — mock whole wallet in upstream tests.

### Mock submitter for tests

```ts
import { circuitAmount, hex32, type Submitter } from "@lelantos-org/sdk";
import type { SubmitTransactPayload } from "@lelantos-org/sdk/protocol";

class MockSubmitter implements Submitter {
    public lastPayload?: SubmitTransactPayload;
    async submit(p: SubmitTransactPayload) {
        this.lastPayload = p;
        // Implementing an SDK interface means producing its branded values;
        // the constructors validate as they brand.
        return { txHash: hex32(`0x${"de".repeat(32)}`) };
    }
}

const submitter = new MockSubmitter();
const wallet = await Wallet.create(keySource, { ...cfg, submitter });
await wallet.deposit({ amount: circuitAmount(100n) });
expect(submitter.lastPayload?.kind).toBe("deposit");
```

### Custom coin selector

```ts
import { circuitAmount, type CoinSelector, type SelectionResult, type StoredNote } from "@lelantos-org/sdk";

class LargestFirstSelector implements CoinSelector {
    select(all: readonly StoredNote[], asset: bigint, target: bigint): SelectionResult {
        const desc = all
            .filter((n) => !n.spent && BigInt(n.asset) === asset)
            .sort((a, b) => Number(BigInt(b.value) - BigInt(a.value)));
        const notes = desc.slice(0, 2);
        const sum = notes.reduce((s, n) => s + BigInt(n.value), 0n);
        if (sum < target) throw new Error("insufficient");
        return { plan: "direct", notes, sum: circuitAmount(sum) };
    }
}

const wallet = await Wallet.create(keySource, { ...cfg, selector: new LargestFirstSelector() });
```

### Custom note source (alt indexer)

A `NoteSource` only supplies the encrypted-note feed. Merkle paths come from
`TreeStore` and the spent set from `NullifierStore`, both built locally from
chunk feeds — neither is a per-item server query, because asking for one path
or one nullifier names the note you are about to spend.

`listNotes` returns a page, not a bare array: `syncWallet` calls it in a loop
until a short page comes back, resuming from a cursor it persists. Two cursors
come back because a feed can be filled out of order:

- `nextAfter` drives the loop within one sync and must advance past everything
  just returned, or paging cannot terminate.
- `resumeAfter` is the highest cursor safe to *write down* and resume from in a
  later session. On a strictly append-only feed it equals `nextAfter`. It lags
  only when rows can still appear below the highest id already served — the
  built-in `matches` source clamps it to the server's backfill watermark for
  exactly that reason, because a cursor placed above the gap would skip those
  rows permanently.

```ts
import type { ListNotesOpts, NotePage, NoteSource } from "@lelantos-org/sdk";
import type { ScanInput } from "@lelantos-org/sdk/sync";

class IndexerNoteSource implements NoteSource {
    async listNotes(opts: ListNotesOpts = {}): Promise<NotePage> {
        const after = opts.after ?? 0;

        // Fetch from your indexer, keeping each row's monotonic id: that id is
        // the cursor, so it has to survive alongside the decoded note.
        const rows: Array<{ id: number; input: ScanInput }> = await Promise.resolve([]);

        // Highest id in the page, falling back to the request cursor so an
        // empty page does not rewind one that has already moved.
        const hi = rows.reduce((m, r) => Math.max(m, r.id), after);

        return {
            inputs: rows.map((r) => r.input),
            nextAfter: hi,
            // Append-only feed: nothing can land below `hi` later.
            resumeAfter: hi,
        };
    }
}
```

---

## Networks

Built-in presets. Unknown names throw at `connect` time.

| Preset | chainId | Status |
|--------|---------|--------|
| `anvil` | 31337 | local |
| `localnet` | 31337 | local (anvil alias) |
| `mainnet` | 1 | deployed |
| `base` | 8453 | deployed |
| `arbitrum` | 42161 | deployed |
| `sepolia` | 11155111 | placeholder → `NetworkNotDeployedError` |

The three deployed chains share one relayer and one fmd server; only the
chainId differs. A preset is a placeholder when its `maspAddress` or
`relayerAddress` is `null`, which is what `connect()` refuses on — `sepolia`
carries service URLs and a `deploymentStatusUrl` but no contracts yet.

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
const signer = new Eip1193Signer(window.ethereum, evmAddress(account), chainId);

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
// Vite / Next.js. The artifacts must match the shape the wallet proves with —
// these are the default 4x4 pair; a pool on `TRANSACT_3X3` loads `3x3/…`
// instead, and mismatching the two produces proofs the verifier rejects.
import wasmUrl from "@lelantos-org/circuits/4x4/4x4.wasm?url";
import zkeyUrl from "@lelantos-org/circuits/4x4/4x4_final.zkey?url";

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
import { browserWorkerProver } from "@lelantos-org/sdk/prover";

const prover = browserWorkerProver({
    workerUrl: new URL("@lelantos-org/sdk/prover-worker", import.meta.url),
    paths: { circuit: wasmUrl, zkey: zkeyUrl },
});
const wallet = await connect({ network: "mainnet", signer, rpcUrl, prover });
```

- `connect()` starts the zkey fetch + parse in the background by default (`proverWarmup: "eager"`), so the first transaction skips the multi-second setup.

#### Where the time goes

`prove()` splits into witness generation and the Groth16 proof. Both are logged at `debug` on `lelantos:prover:wasm`; `npm run test:bench` prints them. Measured on an Apple M3 Max (16 threads, Node), median of three warm runs:

| shape | witness | groth16 | total |
|---|---|---|---|
| 2x2 | 94 ms | 427 ms | ~521 ms |
| 3x3 | 142 ms | 513 ms | ~656 ms |
| **4x4** (default) | 190 ms | 735 ms | ~925 ms |

Cost scales with arity rather than jumping at the default: 4x4 is ~1.4× a 3x3
proof, for a spend that consumes four notes instead of three.

4x4 (`TRANSACT_4X4`, ~40 MB zkey, 53 public-input coefficients) is **the
default**, and is what the deployed verifier accepts. A pool on a narrower
verifier must say so — `connect({ shape: TRANSACT_3X3 })` or `TRANSACT_2X2` —
because a 4x4 proof carries four commitments and 53 coefficients, which neither
accepts. The mismatch shows up as a rejected proof at submit time, not at
connect: the SDK cannot see which verifier a pool deployed.

Witness generation is single-threaded and unaffected by thread count. Groth16 is the part rayon parallelises — 3x3, measured separately on a 16-core Mac:

| threads | 4 | 8 | 16 |
|---|---|---|---|
| groth16 | 1288 ms | 774 ms | 665 ms |

Returns fall off sharply past 8 but have not vanished by 16, which is why the pool is not clamped low. Override with `configureProverThreads(n)`, `LELANTOS_PROVER_THREADS`, or `threads` on `WorkerProver`.

#### Artifact caching

The default shape is 4x4, whose zkey is ~40 MB; 3x3 is ~29 MB. Downloaded artifacts are persisted to the **Cache API** automatically in any browser that has it — nothing to configure. Because the Cache API is origin-scoped rather than per-realm, this covers both a page reload and the prover worker, which previously re-downloaded everything the main thread had already fetched.

The URL is the cache key, so **serve new proving keys under a new path**. There is no revalidation request — a round-trip on every load would defeat the point.

```ts
import { requestPersistentStorage } from "@lelantos-org/sdk/core";
import { clearArtifactCache, configureArtifactCache } from "@lelantos-org/sdk/prover";

// Recommended once at startup: WebKit evicts Cache API storage after ~7 days
// without a visit, which silently restores the cold start. This covers every
// store the origin owns, so a persisted note or tree store benefits too.
await requestPersistentStorage();

await clearArtifactCache();        // reclaim ~90 MB, or force a re-download
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
import { encodeAddress, decodeAddress, buildSpendingKey } from "@lelantos-org/sdk/keys";
import { Poseidon, Jubjub, buildNoteCommitment, buildNullifier, MerkleTree } from "@lelantos-org/sdk/crypto";
import { encryptNote, decryptNote } from "@lelantos-org/sdk/notes";
import { fmdFlag, fmdTest, fmdGenDetectionKey } from "@lelantos-org/sdk/fmd";
import { scanNotes } from "@lelantos-org/sdk/sync";
import { buildDeposit, buildSpend } from "@lelantos-org/sdk/bundle";
import { RelayerClient } from "@lelantos-org/sdk/relayer";
import { prove, verify } from "@lelantos-org/sdk/prover";
```

`buildSpend` covers transfer, withdraw and swap — they differ only in their
public inputs, so there is one builder rather than three. Prover configuration
(`configureProverWasm`, `configureProverThreads`) lives on
`@lelantos-org/sdk/prover`.

`e2e/runner` consumes these directly without `Wallet`.

### Paying a relayer's shielded fee

A relayer may charge for relaying, and charges privately: the fee is an output
note addressed to the relayer, built into the spend it pays for. There is no
on-chain transfer, and so nothing linking the payer to the transaction.

`GET /chains` says whether a relayer charges. **The presence of `shieldedFee`
is the contract** — where it appears, every spend and swap on that chain must
carry a fee output, and one that does not is refused `402`.

<!-- typecheck: skip -->
```ts
import { RelayerClient } from "@lelantos-org/sdk/relayer";
import { buildSpend, feeOutputFromEstimate } from "@lelantos-org/sdk/bundle";

const relayer = new RelayerClient(relayerUrl);
const estimate = await relayer.estimateSpend(chainId, "transfer");

// null when this relayer charges nothing; throws when it charges but cannot
// take `asset` — that spend cannot be relayed at all.
const fee = feeOutputFromEstimate({ J, estimate, asset });
```

`fee` is one slot's `{ note, recipient, randomness }`, spliced into the three
parallel arrays `buildSpend` takes. They are positional, so its entry has to
land at the *same* index in all three — but not at any particular index, and
deliberately not at a fixed one:

<!-- typecheck: skip -->
```ts
const feeValue = fee ? fee.note.value : 0n;
const changeValue = selection.sum - sendValue - feeValue;
const change = splitChange(ownPk, asset, changeValue, shape.nOut - (fee ? 2 : 1));

// One object per slot, shuffled once, then unzipped — so the three arrays
// cannot disagree about where the fee went. `shuffled` is exported from
// `@lelantos-org/sdk/core`; the wallet paths use `finalizeSlots`, which wraps
// this and derives `ownIndices` from the same permutation.
const slots = shuffled([
    { note: sendNote, recipient: to, randomness: perOutput[0] },
    ...change.map((note, i) => ({ note, recipient: own, randomness: perOutput[i + 1] })),
    ...(fee ? [fee] : []),
]);

await buildSpend({
    kind: "transfer",
    outputs:          slots.map((s) => s.note),
    outputRecipients: slots.map((s) => s.recipient),
    outputRandomness: slots.map((s) => s.randomness),
    // …inputs, merkleRoot, prover
});
```

**Shuffle the slots.** The slot index is the only thing left in the output
vector that distinguishes one output from another: `out_cm` is a commitment,
`out_cv` and `out_cv_dep` are blinded with fresh `rcv`, and asset, value and pk
are private. A fixed `[recipient, change, fee]` layout therefore publishes which
commitment is the payee's and which is the relayer's, on every spend, to anyone
reading the chain — and with `nOut = 3` that labels up to a third of the leaves
in the commitment tree as relayer-owned, shrinking the cover set every future
spend draws from. `wallet.transfer` / `withdraw` / `swap` already do this; a
caller driving `buildSpend` by hand should too.

Nothing downstream minds: the circuit's per-slot constraints are independent and
its value balance is per-asset and order-free, and the relayer trial-decrypts
every output slot to find its payment. The one ordering rule is that the shuffle
must happen *before* `buildSpend`, which re-derives each output's `rho` from its
final index.

Because there is no fixed recipient slot, `TransferResult.recipientCommitment`
names the payee's commitment; do not read `commitments[0]`.

Three constraints decide how the fee fits:

- **A fee consumes an output slot.** Arity is fixed by the circuit, so the fee
  replaces a change slot rather than extending the transaction: a transfer with
  a recipient and two change slots gives one of the change slots up to the fee.
  Hence `nOut - 2` above.
- **The fee comes out of change.** `buildSpend` enforces
  `sumIn === publicOut + sumOut` and the fee note is part of `sumOut`, so
  `feeValue` has to come off the change — as above. Forgetting it fails the
  balance check, which is the good outcome; taking it off the recipient's note
  instead would quietly short-pay them.
- **The fee's asset need not be the spend's.** `buildSpend` conserves value per
  asset, the same rule the circuit applies, so one proof may move asset A while
  paying the relayer in asset B. It costs two further slots — an input note of
  B, and an output for B's change — so a cross-asset transfer needs `nOut >= 4`.
  The relayer must still have quoted the asset; one missing from
  `shieldedFee.tokens` cannot pay.

The quote is advisory: it is neither signed nor stored, and the relayer
re-derives what it requires when the spend arrives. `shieldedFee.graceBps` is
the drift it will absorb in between; past that the submit answers `402` and the
fix is to re-estimate and rebuild, not to resubmit. See
[`isShieldedFeeRejection`](#errors).

`feeOutput` is the same thing one level down, for a caller that already has the
address and a circuit-unit amount and does not want the estimate joined for it.

### Naming assets and amounts

Every `asset` / `feeAsset` takes whichever name is to hand — the MASP id, the
token address, or the symbol:

<!-- typecheck: skip -->
```ts
await wallet.transfer({ to, amount: "12.50", asset: "USDC", feeAsset: "WETH" });
await wallet.transfer({ to, amount: 1250n,   asset: 2n });      // same asset
```

Resolution is syntactic, so a ref always means the same thing whatever is
registered: `0x…` is a token address, digits are an id, anything else is a
symbol (case-insensitive). An ambiguous symbol is refused rather than guessed.
The list comes from the relayer's `/chains`; `wallet.assets()` returns it, and
a wallet without a relayer still resolves numeric ids off the chain registry.

Amounts split by **type**, not by magnitude:

| | means |
|---|---|
| `1250n` | exact circuit units |
| `"12.50"` | 12.50 of the token, via its `decimals` |

A `number` is refused: `0.1` has no exact binary representation, and silently
rounding a transfer is worse than asking for `"0.1"`.

### Knowing the fee before you build

`quoteFee` prices a relay and says what can pay for it, checked against your
own balances — so a UI can offer the choice instead of discovering it from a
thrown error:

<!-- typecheck: skip -->
```ts
const { charged, options } = await wallet.quoteFee({ kind: "transfer" });
// options: [{ asset, amount, balance, affordable }, …]
const payable = options.filter((o) => o.affordable);
```

`charged: false` means this relayer subsidises gas and `feeAsset` is moot.
`affordable` is necessary but not sufficient — the notes still have to fit the
circuit's input slots, which only coin selection settles.

**Deposits pay no relayer fee.** Only spends and swaps carry the shielded fee
note; a deposit pays the on-chain protocol `feeBps`, skimmed in the token being
shielded, which is not selectable.

### Letting the wallet do it

`wallet.transfer`, `wallet.withdraw` and `wallet.swap` do all of the above
themselves when the submitter can quote — `HttpRelayerSubmitter` can. They
estimate, build the fee slot, size the change around it, and cover a
cross-asset fee from its own notes. Nothing above is needed unless you are
assembling a spend by hand.

`feeAsset` chooses what pays; it defaults to the asset being moved:

<!-- typecheck: skip -->
```ts
// Move USDC, pay the relayer in WETH.
await wallet.transfer({ to, amount, asset: USDC, feeAsset: WETH });
```

A cross-asset fee needs a note of `feeAsset` to spend and a slot for its
change, so it fails with an insufficient-cover error against `feeAsset` when
there is none — and refuses before proving if the relayer never quoted it.

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
for every published shape — 2×2, 3×3 and 4×4. Their `y` values come from
witnesses the compiled circuit produced, so a mismatch means the SDK would
build a witness the on-chain verifier rejects.
`src/circuit/shape-proving.test.ts` closes the loop for each shape by proving a
golden witness with that shape's zkey and verifying it against its
verification key.

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

const wallet = await connect({ mnemonic, network: "anvil", privateKey: privKeyHex, rpcUrl });
await wallet.sync();

const pay  = x402(wallet, { budget: { total: "5" } });
const data = await pay("https://api.example.com/premium").then((r) => r.json());
```

`pay` is an ordinary `fetch`, which is the whole integration story — every
agent framework already takes one:

<!-- typecheck: skip -->
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

<!-- typecheck: skip -->
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

A relayer that refuses a submission over its
[shielded fee](#paying-a-relayers-shielded-fee) answers `402`, which arrives as
a `NetworkError`. `isShieldedFeeRejection` is the guard — the status alone is
decisive, because the relayer returns `402` for nothing else, but a named
predicate says which `402` a call site means (x402 uses the same status for a
payment *challenge*, handled separately by `onPaymentRequired`).

<!-- typecheck: skip -->
```ts
import { isShieldedFeeRejection } from "@lelantos-org/sdk/relayer";

try {
    await relayer.submitTransact(payload);
} catch (e) {
    if (!isShieldedFeeRejection(e)) throw e;
    // e.body carries the relayer's reason in prose: which asset, what was
    // paid, what was required, and the grace band.
    // The quote went stale — re-estimate and rebuild. Resubmitting the same
    // payload is refused again.
}
```

| Class | Code | Notes |
|---|---|---|
| `InsufficientCoverError` | `INSUFFICIENT_COVER` | No 1/2-note cover. Pass `autoConsolidate` or read `consolidate: StoredNote[]`. |
| `WalletConfigError` | `WALLET_CONFIG` | `missing: string[]` lists all problems. |
| `NetworkError` | `RELAYER_*` / `FMD_*` | Wraps fetch failures + timeouts. Fields: `url`, `status?`, `body?`, `cause?`. HTTP clients retry 5xx, 408, 429 and network errors 3 times (exp backoff); `402` is not retried. See `isShieldedFeeRejection` above. |
| `ProverError` | `PROVER_FAILED` | Proof generation failed. |
| `ProverArtifactsMissingError` | `PROVER_ARTIFACTS_MISSING` | Field `tried: string[]`. Fix: pass `proverArtifacts`, install companion, or set `LELANTOS_PROVER_ARTIFACTS_DIR`. |
| `PermitRejectedError` | `PERMIT_REJECTED` | User rejected EIP-2612 sig. |
| `DepositAdapterError` | `DEPOSIT_ADAPTER` | Strategy mismatch (`native`/`allowance`/`witness`). |
| `SelectionError` | `SELECTION` | Coin-selector failure. Field `asset?`. |
| `TxMiningError` | `TX_MINING` | Chain tx submitted but not mined / reverted. |
| `NetworkNotDeployedError` | `NETWORK_NOT_DEPLOYED` | Field `network: string`. Pick deployed preset or pass `NetworkPreset` literal. |
| `X402PaymentError` | `X402_PAYMENT` | Field `reason`: `budget-exceeded`, `per-request-limit`, `host-not-allowed`, `no-acceptable-requirements`, `unsupported-requirements`, `payment-rejected`. Every reason except `payment-rejected` means no funds moved. |

`HttpClientOptions` (`{ timeoutMs, retries, backoffMs }`) is passed to
`FmdClient` or `RelayerClient` at construction; inject the configured client
through `noteSource` / `submitter` to change it.

Defaults: **3** retries after the first attempt, 250 ms backoff doubling with
±25% jitter, and a per-attempt timeout of **15 000 ms for idempotent requests
(GET/HEAD/OPTIONS)** or **30 000 ms for submits**. The timeout is per attempt,
not per call, so a fully retried request can outlive it several times over —
set `timeoutMs` *and* `retries` when a call sits on a latency budget, as a poll
does.
