// High-level Wallet. Owns keys + in-memory note cache; every external
// dependency (ChainAdapter, NoteSource, Submitter, Prover, CoinSelector,
// NoteStore) is injected.

import { buildNullifierFromNsk, type Jubjub, Poseidon } from "../crypto/index.js";
import { buildJubjub } from "../crypto/jubjub-wasm.js";
import { hexPrivateKeyToNsk, type KeySource, resolveNsk } from "../keys/key-source.js";
import { addressFromSpendingKey, buildSpendingKey, type SpendingKey } from "../keys/keys.js";
import type { Prover } from "../prover/interface.js";
import { LocalScanner, type Scanner } from "../sync/scanner.js";
import type {
    DepositOptions,
    NotesFilter,
    SwapOptions,
    TransactionResult,
    TransferOptions,
    WalletApi,
    WalletNote,
    WithdrawEthOptions,
    WithdrawOptions,
} from "./api.js";
import type { WalletConfig } from "./config.js";
import {
    AWAIT_COMMITMENTS_DEFAULT_MAX_ATTEMPTS,
    AWAIT_COMMITMENTS_DEFAULT_POLL_MS,
    AWAIT_COMMITMENTS_SYNC_LIMIT,
} from "./constants.js";
import { defaultNoteSource, defaultProver, defaultSubmitter, validateConfig } from "./defaults.js";
import { executeDeposit } from "./deposit.js";
import { toWalletNote } from "./internal.js";
import type { NoteSource } from "./note-source.js";
import { InMemoryNoteStore, type NoteStore, type NotesFile } from "./note-store.js";
import {
    type CoinSelector,
    type SelectionResult,
    type SelectOpts,
    SfrtCoinSelector,
} from "./selection.js";
import type { Submitter } from "./submitter.js";
import { executeSwap } from "./swap.js";
import { type SyncProgress, type SyncResult, syncWallet } from "./sync.js";
import { executeTransfer } from "./transfer.js";
import { executeWithdraw, type WithdrawKind } from "./withdraw.js";

/**
 * Warm WasmJubjub's circomlibjs fallback so subsequent sync `hashToAssetGen`
 * calls in `buildDeposit` don't throw. No-op on Jubjub impls without async
 * variant (already-warmed circomlibjs path).
 * @internal
 */
export async function warmAssetGen(J: Jubjub, asset: bigint): Promise<void> {
    const maybeAsync = (J as { hashToAssetGenAsync?: (a: bigint) => Promise<unknown> })
        .hashToAssetGenAsync;
    if (typeof maybeAsync === "function") await maybeAsync.call(J, asset);
}

/**
 * Swallow callback errors so a misbehaving listener can't break a tx.
 * @internal
 */
export function safePhase<P>(cb: ((p: P) => void) | undefined, phase: P): void {
    if (!cb) return;
    try {
        cb(phase);
    } catch {
        /* ignore */
    }
}

export class Wallet implements WalletApi {
    readonly P: Poseidon;
    readonly J: Jubjub;
    readonly keys: SpendingKey;
    readonly address: string;
    readonly cfg: WalletConfig;
    readonly noteStore: NoteStore;
    readonly noteSource: NoteSource;
    readonly submitter: Submitter;
    readonly prover: Prover;
    readonly selector: CoinSelector;
    readonly scanner: Scanner;
    /** @internal — exposed for the per-tx helper modules in `./{deposit,transfer,withdraw,swap}.ts`. */
    file: NotesFile;

    get chain(): WalletConfig["chain"] {
        return this.cfg.chain;
    }

    private constructor(args: {
        P: Poseidon;
        J: Jubjub;
        keys: SpendingKey;
        address: string;
        cfg: WalletConfig;
        file: NotesFile;
        noteStore: NoteStore;
        noteSource: NoteSource;
        submitter: Submitter;
        prover: Prover;
        selector: CoinSelector;
        scanner: Scanner;
    }) {
        this.P = args.P;
        this.J = args.J;
        this.keys = args.keys;
        this.address = args.address;
        this.cfg = args.cfg;
        this.file = args.file;
        this.noteStore = args.noteStore;
        this.noteSource = args.noteSource;
        this.submitter = args.submitter;
        this.prover = args.prover;
        this.selector = args.selector;
        this.scanner = args.scanner;
    }

    /// Single-call wallet builder. See `./connect.ts` for full options.
    ///
    /// ```ts
    /// const wallet = await Wallet.connect({
    ///     network: "anvil",
    ///     mnemonic,
    ///     privateKey: "0x...",
    ///     rpcUrl: "http://localhost:8545",
    ///     proverArtifacts: { circuit: "/2x2.wasm", zkey: "/2x2.zkey" },
    /// });
    /// ```
    static async connect(opts: import("./connect.js").ConnectOptions): Promise<WalletApi> {
        const { connect } = await import("./connect.js");
        return connect(opts);
    }

    /// Equivalent to `Wallet.connect({ ...opts, mnemonic })`. Chain layer
    /// must still come from `opts`.
    static async fromMnemonic(
        mnemonic: string,
        opts: Omit<import("./connect.js").ConnectOptions, "mnemonic" | "signature" | "nsk"> & {
            account?: number;
            passphrase?: string;
        },
    ): Promise<WalletApi> {
        return Wallet.connect({ ...opts, mnemonic });
    }

    /// 0x-hex EVM key both signs txs and derives nsk via `hexPrivateKeyToNsk`.
    static async fromPrivateKey(
        privateKey: string,
        opts: Omit<
            import("./connect.js").ConnectOptions,
            "mnemonic" | "signature" | "nsk" | "privateKey"
        >,
    ): Promise<WalletApi> {
        return Wallet.connect({
            ...opts,
            privateKey,
            nsk: hexPrivateKeyToNsk(privateKey),
        });
    }

    /// Derive nsk by asking the signer to sign the canonical EIP-712
    /// message. One signature prompt at boot; same signer reused for txs.
    static async fromSigner(
        signer: import("ethers").Signer,
        opts: Omit<
            import("./connect.js").ConnectOptions,
            "mnemonic" | "signature" | "nsk" | "signer"
        >,
    ): Promise<WalletApi> {
        const { deriveNskFromSigner } = await import("../keys/metamask.js");
        const nsk = await deriveNskFromSigner(signer);
        return Wallet.connect({ ...opts, signer, nsk });
    }

    /// Build from any key source. Wires defaults for omitted pluggables.
    /// Collects every config problem into `WalletConfigError.missing`.
    static async create(source: KeySource, cfg: WalletConfig): Promise<Wallet> {
        validateConfig(cfg);

        const P = await Poseidon.build();
        const J = await buildJubjub();
        const nsk = resolveNsk(source);
        const keys = buildSpendingKey(P, J, nsk);
        const address = addressFromSpendingKey(J, keys);

        const noteStore = cfg.noteStore ?? new InMemoryNoteStore();
        const file = await noteStore.load();

        const noteSource = cfg.noteSource ?? defaultNoteSource(cfg, J);
        const submitter = cfg.submitter ?? defaultSubmitter(cfg);
        const prover = cfg.prover ?? (await defaultProver(cfg));
        const selector = cfg.selector ?? new SfrtCoinSelector();
        const scanner = cfg.scanner ?? new LocalScanner(J, P);

        return new Wallet({
            P,
            J,
            keys,
            address,
            cfg: { ...cfg, noteStore, noteSource, submitter, prover, selector, scanner },
            file,
            noteStore,
            noteSource,
            submitter,
            prover,
            selector,
            scanner,
        });
    }

    /// Pull encrypted notes, trial-decrypt with `ivk + dk`, persist hits.
    /// Idempotent — resumes from `lastIndex` cursor.
    async sync(opts?: {
        limit?: number;
        onProgress?: (p: SyncProgress) => void;
    }): Promise<SyncResult> {
        const result = await syncWallet(
            {
                J: this.J,
                ivk: this.keys.ivk,
                dk: this.keys.dk,
                source: this.noteSource,
                store: this.noteStore,
                scanner: this.scanner,
            },
            opts ?? {},
        );
        await this.reconcileSpentOnChain();
        this.file = await this.noteStore.load();
        return result;
    }

    /**
     * Mark locally-unspent notes whose nullifiers are already consumed
     * on chain; single batch via `noteSource.spentSet`.
     * @internal
     */
    async reconcileSpentOnChain(): Promise<void> {
        const file = await this.noteStore.load();
        const candidates = file.notes
            .filter((n) => !n.spent)
            .map((note) => ({
                note,
                nf: buildNullifierFromNsk(this.P, this.keys.nsk, BigInt(note.rho)),
            }));
        if (candidates.length === 0) return;
        const spent = await this.noteSource.spentSet(candidates.map((c) => c.nf));
        if (spent.size === 0) return;
        let mutated = false;
        for (const { note, nf } of candidates) {
            if (spent.has(nf)) {
                note.spent = true;
                mutated = true;
            }
        }
        if (mutated) await this.noteStore.save(file);
    }

    /// Reload in-memory cache from `NoteStore` after external mutation.
    async refresh(): Promise<void> {
        this.file = await this.noteStore.load();
    }

    /// Resolve once every `cms` entry is persisted locally. Polls `sync()`
    /// with backoff until observed or `signal` aborts.
    async awaitCommitments(
        cms: string[],
        opts: { signal?: AbortSignal; pollMs?: number; maxAttempts?: number } = {},
    ): Promise<void> {
        if (cms.length === 0) return;
        const target = cms.map((c) => c.toLowerCase());
        const pollMs = opts.pollMs ?? AWAIT_COMMITMENTS_DEFAULT_POLL_MS;
        const maxAttempts = opts.maxAttempts ?? AWAIT_COMMITMENTS_DEFAULT_MAX_ATTEMPTS;
        const allSeen = (): boolean => {
            const seen = new Set(this.file.notes.map((n) => n.cm.toLowerCase()));
            return target.every((c) => seen.has(c));
        };
        const sleep = (ms: number) =>
            new Promise<void>((resolve) => {
                if (opts.signal?.aborted) return resolve();
                const t = setTimeout(() => {
                    opts.signal?.removeEventListener("abort", onAbort);
                    resolve();
                }, ms);
                const onAbort = () => {
                    clearTimeout(t);
                    resolve();
                };
                opts.signal?.addEventListener("abort", onAbort, { once: true });
            });
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            if (opts.signal?.aborted) return;
            if (allSeen()) return;
            await this.sync({ limit: AWAIT_COMMITMENTS_SYNC_LIMIT });
            if (opts.signal?.aborted || allSeen()) return;
            await sleep(pollMs);
        }
    }

    notes(filter: NotesFilter): WalletNote[] {
        return this.file.notes
            .filter((n) => {
                if (filter.spent !== undefined && n.spent !== filter.spent) return false;
                if (BigInt(n.asset) !== filter.asset) return false;
                return true;
            })
            .map(toWalletNote);
    }

    allNotes(filter: { spent?: boolean } = {}): WalletNote[] {
        return this.file.notes
            .filter((n) => filter.spent === undefined || n.spent === filter.spent)
            .map(toWalletNote);
    }

    balance(asset: bigint): bigint {
        return this.file.notes
            .filter((n) => !n.spent && BigInt(n.asset) === asset)
            .reduce((s, n) => s + BigInt(n.value), 0n);
    }

    selectNotes(asset: bigint, target: bigint, opts?: SelectOpts): SelectionResult {
        return this.selector.select(this.file.notes, asset, target, opts);
    }

    /// Shield ERC-20 into the MASP via Permit2 escrow. Funds sit in
    /// escrow until the relayer flushes a batch (or `cancelIntent` after
    /// `cancelDelay` blocks). For native ETH set `asEth: true`.
    async deposit(args: DepositOptions): Promise<TransactionResult> {
        return executeDeposit(this, args);
    }

    /// Cancel an escrowed deposit. Permissionless after `cancelDelay`
    /// blocks. Caller supplies the `IntentEscrowed` event payload for the
    /// on-chain digest check.
    async cancelIntent(
        id: bigint,
        inputs: import("../chain/adapter.js").CancelIntentInputs,
    ): Promise<{ txHash: string }> {
        const { DepositAdapterError } = await import("./errors/index.js");
        if (!this.cfg.chain.cancelIntent) {
            throw new DepositAdapterError("witness", ["cancelIntent"]);
        }
        return this.cfg.chain.cancelIntent(id, inputs);
    }

    /// Shielded transfer: 1-2 notes → send-note + change-note → submit →
    /// mark spent. Throws `InsufficientCoverError` on no 1/2-note cover.
    async transfer(args: TransferOptions): Promise<TransactionResult> {
        return executeTransfer(this, args);
    }

    /// Unshield ERC20 to `args.to`. Throws `InsufficientCoverError` on no cover.
    async withdraw(args: WithdrawOptions): Promise<TransactionResult> {
        return executeWithdraw(this, { ...args, asset: args.asset ?? 1n }, "withdraw");
    }

    /// Unshield to raw ETH via `MASP.withdrawNative`; MASP unwraps WETH.
    async withdrawEth(args: WithdrawEthOptions): Promise<TransactionResult> {
        return executeWithdraw(
            this,
            {
                to: args.to,
                amount: args.amount,
                asset: args.asset,
                selectOpts: args.selectOpts,
                autoConsolidate: args.autoConsolidate,
                onPhase: args.onPhase,
            },
            "withdrawNative",
        );
    }

    /// Atomic shielded swap. Leg-1 transact_2x2 unshields to SwapWrapper;
    /// leg-2 deposit intent re-shields the B note. Bundled via
    /// `submitter.submitSwap`. `args.amount` is gross publicOut in circuit
    /// units of `assetIn`; MASP skims `feeBps` before transferring.
    async swap(args: SwapOptions): Promise<TransactionResult> {
        return executeSwap(this, args);
    }

    /// Called automatically by `transfer` / `withdraw`; exposed for
    /// alternative spend flows.
    async markSpent(noteIds: string[]): Promise<void> {
        const ids = new Set(noteIds);
        this.file.notes.forEach((n) => {
            if (ids.has(n.id)) n.spent = true;
        });
        await this.noteStore.save(this.file);
    }

    /**
     * Self-spend the two smallest notes for `asset` into one change note.
     * Sends `consolidateSum - 1n` so a 1-unit change note pops out (some
     * selectors discard zero-value change).
     * @internal — used by per-tx helper modules for the auto-consolidate fallback.
     */
    async autoConsolidate(
        asset: bigint,
        selection: Extract<SelectionResult, { plan: "consolidate-first" }>,
    ): Promise<void> {
        const target =
            selection.consolidateSum > 1n
                ? selection.consolidateSum - 1n
                : selection.consolidateSum;
        await this.transfer({
            to: this.address,
            amount: target,
            asset,
            // Inner call must NOT recurse.
            autoConsolidate: false,
        });
        await this.sync();
    }

    /** @internal */
    async resolveFeeBps(): Promise<bigint> {
        return this.cfg.feeBps ?? (await this.cfg.chain.fetchFeeBps());
    }

    /** @internal */
    inputsCtx() {
        return { pk: this.keys.pk, nsk: this.keys.nsk, noteSource: this.noteSource };
    }
}

export type { WithdrawKind };
