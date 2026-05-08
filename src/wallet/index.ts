// High-level Wallet — primary integration surface for `@lelantos-org/sdk`.
//
// Owns: keys, in-memory note cache, plus *injected* pluggables for every
// external dependency:
//
//   - ChainAdapter   → RPC + permit signing
//   - NoteSource     → encrypted-note feed + merkle paths (default: fmd-webserver)
//   - Submitter      → transact-bundle delivery (default: HTTP relayer)
//   - Prover         → Groth16 prover (default: snarkjs in-process)
//   - CoinSelector   → coin selection strategy (default: SFRT)
//   - NoteStore      → persistence (default: in-memory)
//
// Apps can swap any one for tests, alt transports, hardware wallets,
// custom strategies — without touching the rest.

import { decodeAddress } from "../address.js";
import { buildDeposit, buildTransfer, buildWithdraw, buildWithdrawNative } from "../bundle.js";
import { computePiHash } from "../permit2.js";
import { buildNullifierFromNsk, type Jubjub, Poseidon } from "../crypto/index.js";
import { buildJubjub } from "../crypto/jubjub-wasm.js";
import { addressFromSpendingKey, buildSpendingKey, type SpendingKey } from "../keys.js";
import type { Note } from "../notes.js";
import type {
    DepositOptions,
    NotesFilter,
    TransactionResult,
    TransferOptions,
    WalletApi,
    WalletNote,
    WithdrawEthOptions,
    WithdrawOptions,
} from "./api.js";
import type { WalletConfig } from "./config.js";
import { ensureCover } from "./cover.js";
import { supportsAllowanceTransfer, supportsNativeEth } from "./chain-adapter.js";
import { defaultNoteSource, defaultProver, defaultSubmitter, validateConfig } from "./defaults.js";
import { DepositAdapterError, type DepositStrategy } from "./errors.js";
import { buildInputSlots } from "./inputs.js";
import {
    freshNoteRandomness,
    freshOutput,
    makeTransactionResult,
    toWalletNote,
} from "./internal.js";
import { type KeySource, resolveNsk } from "./key-source.js";
import type { NoteSource } from "./note-source.js";
import { InMemoryNoteStore, type NoteStore, type NotesFile } from "./note-store.js";
import type { Prover } from "./prover.js";
import { randomFr, randomJubjubScalar } from "./randomness.js";
import { LocalScanner, type Scanner } from "./scanner.js";
import {
    type CoinSelector,
    type SelectionResult,
    type SelectOpts,
    SfrtCoinSelector,
} from "./selection.js";
import type { Submitter } from "./submitter.js";
import { type SyncProgress, type SyncResult, syncWallet } from "./sync.js";

// Re-export the public types so existing
// `import { ..., DepositOptions } from "@lelantos-org/sdk"` keeps working.
export type {
    DepositOptions,
    NotesFilter,
    TransactionResult,
    TransferOptions,
    WalletApi,
    WalletNote,
    WithdrawEthOptions,
    WithdrawOptions,
};

const PERMIT2_DEFAULT_DEADLINE_SECS = 3600;
/// Refuse to use a Permit2 allowance window expiring within this many
/// seconds. Avoids racing past expiration mid-tx.
const ALLOWANCE_BUFFER_SECS = 60;

/// Fire a progress phase, swallowing any callback errors so a misbehaving
/// UI listener can't break a tx mid-flight.
function safePhase<P>(cb: ((p: P) => void) | undefined, phase: P): void {
    if (!cb) return;
    try {
        cb(phase);
    } catch {
        /* ignore */
    }
}

/// Default `WalletApi` implementation.
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
    private file: NotesFile;

    /// Chain adapter the wallet is bound to. Same instance as `cfg.chain`
    /// — exposed at the top level so consumers don't reach through `cfg`.
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

    /// Single-call wallet builder for the common path. Resolves a network
    /// preset, builds the chain adapter from a signer/privateKey, picks
    /// scanner + prover by runtime. See `./connect.ts` for full options.
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

    /// Build a wallet from any key source. Wires defaults for any
    /// pluggable not supplied in `cfg`. Use `Wallet.connect()` for the
    /// common path; reach for `Wallet.create` when you need to inject all
    /// pluggables yourself.
    ///
    /// Collects every config problem in `WalletConfigError.missing` so
    /// callers see the full picture rather than fixing them one at a time.
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
        const prover = cfg.prover ?? defaultProver(cfg);
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

    // ---------- cache + sync ----------

    /// Pull encrypted notes from the configured `NoteSource`, trial-decrypt
    /// with `ivk + dk`, persist hits to `NoteStore`. Idempotent — re-runs
    /// resume from the store's `lastIndex` cursor.
    /// `opts.limit` caps the number of new notes scanned this call.
    /// `opts.onProgress` receives sync-phase updates for UI spinners.
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

    /// Walk locally-unspent notes and mark any whose nullifier is already
    /// consumed on chain as spent. Catches state where the contract burned
    /// a note in a prior session that the local store never recorded.
    /// Single batch roundtrip via `noteSource.spentSet`.
    private async reconcileSpentOnChain(): Promise<void> {
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

    /// Reload the in-memory note cache from `NoteStore`. Useful after an
    /// external process mutates the store (e.g. a worker thread).
    async refresh(): Promise<void> {
        this.file = await this.noteStore.load();
    }

    /// Resolve once every commitment in `cms` is decrypted and persisted to
    /// the local note store. Polls `sync()` with backoff until either all
    /// commitments are observed or `signal` aborts. Useful for UIs that
    /// want to update balances only after the FMD scanner caught up to
    /// fresh change notes (post-transfer / -withdraw).
    async awaitCommitments(
        cms: string[],
        opts: { signal?: AbortSignal; pollMs?: number; maxAttempts?: number } = {},
    ): Promise<void> {
        if (cms.length === 0) return;
        const target = cms.map((c) => c.toLowerCase());
        const pollMs = opts.pollMs ?? 1500;
        const maxAttempts = opts.maxAttempts ?? 30;
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
            await this.sync({ limit: 200 });
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

    // ---------- transactions ----------

    /// Shield an ERC-20 into the MASP via Permit2 escrow. Steps: fetch asset
    /// entry + fee, build DepositIntent + AuxValidation.Output[2], sign
    /// Permit2 witness over their hash, submit. Either the chain adapter
    /// (`chain.submitIntent`) or the relayer (`submitter.submitIntent`)
    /// broadcasts `MASP.submitIntent`. Funds sit in escrow until the
    /// relayer flushes a batch (or the depositor calls `cancelIntent`
    /// after `cancelDelay` blocks). For native ETH, wrap to WETH off-pool
    /// then deposit with the WETH asset id.
    async deposit(args: DepositOptions): Promise<TransactionResult> {
        const asset = args.asset ?? 1n;
        const recipient = decodeAddress(this.J, args.to ?? this.address);
        const payer = await this.cfg.chain.payerAddress();
        const assetEntry = await this.cfg.chain.fetchAsset(asset);
        const feeBps = await this.resolveFeeBps();
        const inAmt = args.amount * assetEntry.scale;
        const fee = (inAmt * feeBps) / 10000n;
        const total = inAmt + fee;

        const o0 = freshOutput();
        const o1 = freshNoteRandomness();
        const built = buildDeposit({
            P: this.P,
            J: this.J,
            chainId: this.cfg.chainId,
            asset,
            payerAddress: payer,
            recipientAddress: payer,
            publicIn: args.amount,
            recipient,
            output0: { rho: o0.rho, rcm: o0.rcm, rcv: o0.rcv, aux: o0.aux },
            output1Pad: { rho: o1.rho, rcm: o1.rcm, rcv: o1.rcv },
        });

        const strategy = await this.pickDepositStrategy(args, payer, assetEntry.token);
        const { txHash, intentId } = await this.runDepositStrategy(strategy, {
            built,
            args,
            assetEntry,
            total,
        });

        const result = makeTransactionResult({
            txHash,
            built: { cm: built.cm, producedNotes: built.producedNotes },
            sent: args.amount,
            inputSum: 0n,
            // Both deposit outputs are credited to the depositor's own
            // shielded address (recipient = payer in DepositForm).
            ownIndices: [0, 1],
        });
        return { ...result, intentId };
    }

    /// Pick the cheapest deposit submission path the adapter supports for
    /// `args`. Order: native ETH (msg.value, no Permit2) > Permit2
    /// AllowanceTransfer (pre-signed window covers pull) > Permit2 witness
    /// (per-deposit sig — fallback).
    private async pickDepositStrategy(
        args: DepositOptions,
        payer: string,
        token: string,
    ): Promise<DepositStrategy> {
        const chain = this.cfg.chain;
        if (args.asEth) {
            if (!supportsNativeEth(chain)) {
                throw new DepositAdapterError("native", ["submitIntentNative"]);
            }
            return "native";
        }
        if (supportsAllowanceTransfer(chain)) {
            const masp = await chain.maspAddress();
            const allow = await chain.permit2Allowance(token, payer, masp);
            const nowSec = Math.floor(Date.now() / 1000);
            const total = await this.computeDepositTotal(args, token);
            if (allow.amount >= total && allow.expiration > nowSec + ALLOWANCE_BUFFER_SECS) {
                return "allowance";
            }
        }
        if (!this.submitter.submitIntent && !chain.submitIntent) {
            throw new DepositAdapterError("witness", [
                "submitter.submitIntent | chain.submitIntent",
            ]);
        }
        return "witness";
    }

    /// Run the picked deposit strategy. Single point of `chain.submit*` /
    /// `submitter.submitIntent` invocation — every branch returns the same
    /// `{ txHash, intentId }` shape.
    private async runDepositStrategy(
        strategy: DepositStrategy,
        ctx: {
            built: ReturnType<typeof buildDeposit>;
            args: DepositOptions;
            assetEntry: { token: string; scale: bigint };
            total: bigint;
        },
    ): Promise<{ txHash: string; intentId?: bigint }> {
        const { built, args, assetEntry, total } = ctx;
        const chain = this.cfg.chain;

        if (strategy === "native") {
            safePhase(args.onPhase, "submitting");
            return chain.submitIntentNative!({
                intent: built.intent,
                aux: built.aux,
                value: total,
            });
        }
        if (strategy === "allowance") {
            safePhase(args.onPhase, "submitting");
            return chain.submitIntentAuthorized!({ intent: built.intent, aux: built.aux });
        }
        // witness path
        const deadline =
            args.deadline ?? BigInt(Math.floor(Date.now() / 1000) + PERMIT2_DEFAULT_DEADLINE_SECS);
        const piHash = computePiHash(built.intent, built.aux);
        const nonce = chain.permit2Nonce ? await chain.permit2Nonce() : BigInt(Date.now());
        safePhase(args.onPhase, "signing");
        const permit2 = await chain.signPermit2({
            token: assetEntry.token,
            maxTotal: total,
            deadline,
            piHash,
            nonce,
        });
        safePhase(args.onPhase, "submitting");
        if (this.submitter.submitIntent) {
            return this.submitter.submitIntent({
                chainId: this.cfg.chainId,
                intent: built.intent,
                permit2,
                aux: built.aux,
            });
        }
        return chain.submitIntent!({ intent: built.intent, permit2, aux: built.aux });
    }

    /// Read on-chain fee + asset scale so we can recompute the exact total
    /// the strategy picker compares against the allowance window. Re-reads
    /// rather than threading state — these calls are cached/cheap.
    private async computeDepositTotal(args: DepositOptions, _token: string): Promise<bigint> {
        const asset = args.asset ?? 1n;
        const entry = await this.cfg.chain.fetchAsset(asset);
        const feeBps = await this.resolveFeeBps();
        const inAmt = args.amount * entry.scale;
        return inAmt + (inAmt * feeBps) / 10000n;
    }

    /// Cancel an escrowed-but-not-yet-flushed deposit. Permissionless after
    /// `cancelDelay` blocks; funds + fees return to the original payer.
    async cancelIntent(id: bigint): Promise<{ txHash: string }> {
        if (!this.cfg.chain.cancelIntent) {
            throw new DepositAdapterError("witness", ["cancelIntent"]);
        }
        return this.cfg.chain.cancelIntent(id);
    }

    /// Internal shielded transfer. Selects 1-2 unspent notes covering
    /// `args.amount`, builds transact bundle with one send-note to
    /// `args.to` + one change-note back to self, submits, then marks the
    /// spent notes in `NoteStore`. Throws `InsufficientCoverError` if the
    /// SFRT selector can't find a 1- or 2-note cover (call `notes()` /
    /// `selectNotes()` first if you want to inspect the plan without
    /// triggering a transfer).
    async transfer(args: TransferOptions): Promise<TransactionResult> {
        const asset = args.asset ?? 1n;
        const sendValue = args.amount;

        safePhase(args.onPhase, "preparing");
        const selection = await ensureCover(
            this.selector,
            () => this.file.notes,
            {
                asset,
                target: sendValue,
                selectOpts: args.selectOpts,
                autoConsolidate: args.autoConsolidate,
            },
            (a, sel) => this.autoConsolidate(a, sel),
        );

        const recipient = decodeAddress(this.J, args.to);
        const ownAddr = decodeAddress(this.J, this.address);
        const inputs = await buildInputSlots(this.inputsCtx(), selection.notes, asset);

        const changeValue = selection.sum - sendValue;
        const sendNote: Note = {
            asset,
            value: sendValue,
            pk: recipient.pk,
            rho: randomFr(),
            rcm: randomFr(),
            rcv: randomJubjubScalar(),
        };
        const changeNote: Note = {
            asset,
            value: changeValue,
            pk: this.keys.pk,
            rho: randomFr(),
            rcm: randomFr(),
            rcv: randomJubjubScalar(),
        };

        const merkleRoot = (await this.noteSource.fetchPath(selection.notes[0].cm)).root;

        safePhase(args.onPhase, "proving");
        const built = await buildTransfer({
            P: this.P,
            J: this.J,
            chainId: this.cfg.chainId,
            asset,
            payerAddress: this.cfg.relayerAddress,
            relayerAddress: this.cfg.relayerAddress,
            recipientAddress: this.cfg.relayerAddress,
            prover: this.prover,
            treeDepth: this.cfg.treeDepth,
            inputs,
            merkleRoot,
            outputs: [sendNote, changeNote],
            outputRecipients: [recipient, ownAddr],
            outputRandomness: [
                { esk: randomJubjubScalar(), fmdR: randomJubjubScalar() },
                { esk: randomJubjubScalar(), fmdR: randomJubjubScalar() },
            ],
        });

        safePhase(args.onPhase, "submitting");
        const { txHash } = await this.submitter.submit(built.payload);
        const spent = selection.notes.map((n) => n.id);
        await this.markSpent(spent);
        // Output 0 = recipient (not own unless self-transfer); output 1 = change to self.
        const isSelf = args.to === this.address;
        const ownIndices = isSelf ? [0, 1] : [1];
        return makeTransactionResult({
            txHash,
            built,
            spent,
            inputSum: selection.sum,
            sent: sendValue,
            change: changeValue,
            ownIndices,
        });
    }

    /// Unshield ERC20 to `args.to` (eth address). Selects 1-2 notes,
    /// releases `args.amount` on-chain, splits remainder into two
    /// change-notes back to self, submits, marks spent. Throws
    /// `InsufficientCoverError` on no cover.
    async withdraw(args: WithdrawOptions): Promise<TransactionResult> {
        return this.withdrawCore({ ...args, asset: args.asset ?? 1n }, "withdraw");
    }

    /// Unshield to raw ETH via `MASP.withdrawNative`. Same selection + bundle
    /// shape as `withdraw`; payload tagged `kind: "withdrawNative"` so the
    /// relayer routes accordingly. MASP unwraps WETH and forwards raw ETH
    /// to `args.to`.
    async withdrawEth(args: WithdrawEthOptions): Promise<TransactionResult> {
        return this.withdrawCore(
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

    private async withdrawCore(
        args: WithdrawOptions & { asset: bigint },
        kind: "withdraw" | "withdrawNative",
    ): Promise<TransactionResult> {
        const { asset } = args;
        const feeBps = await this.resolveFeeBps();
        const fee = (args.amount * feeBps) / 10000n;
        const publicOut = args.amount + fee;

        safePhase(args.onPhase, "preparing");
        const selection = await ensureCover(
            this.selector,
            () => this.file.notes,
            {
                asset,
                target: publicOut,
                selectOpts: args.selectOpts,
                autoConsolidate: args.autoConsolidate,
            },
            (a, sel) => this.autoConsolidate(a, sel),
        );

        const ownAddr = decodeAddress(this.J, this.address);
        const inputs = await buildInputSlots(this.inputsCtx(), selection.notes, asset);

        const remainder = selection.sum - publicOut;
        const half = remainder / 2n;
        const change0: Note = {
            asset,
            value: half,
            pk: this.keys.pk,
            rho: randomFr(),
            rcm: randomFr(),
            rcv: randomJubjubScalar(),
        };
        const change1: Note = {
            asset,
            value: remainder - half,
            pk: this.keys.pk,
            rho: randomFr(),
            rcm: randomFr(),
            rcv: randomJubjubScalar(),
        };

        const merkleRoot = (await this.noteSource.fetchPath(selection.notes[0].cm)).root;

        safePhase(args.onPhase, "proving");
        const builder = kind === "withdrawNative" ? buildWithdrawNative : buildWithdraw;
        const built = await builder({
            P: this.P,
            J: this.J,
            chainId: this.cfg.chainId,
            asset,
            payerAddress: this.cfg.relayerAddress,
            relayerAddress: this.cfg.relayerAddress,
            recipientAddress: args.to,
            prover: this.prover,
            treeDepth: this.cfg.treeDepth,
            inputs,
            merkleRoot,
            publicOut,
            change: [change0, change1],
            changeRecipients: [ownAddr, ownAddr],
            changeRandomness: [
                { esk: randomJubjubScalar(), fmdR: randomJubjubScalar() },
                { esk: randomJubjubScalar(), fmdR: randomJubjubScalar() },
            ],
        });

        safePhase(args.onPhase, "submitting");
        const { txHash } = await this.submitter.submit(built.payload);
        const spent = selection.notes.map((n) => n.id);
        await this.markSpent(spent);
        return makeTransactionResult({
            txHash,
            built,
            spent,
            inputSum: selection.sum,
            sent: publicOut,
            change: remainder,
            // Both outputs are change-to-self.
            ownIndices: [0, 1],
        });
    }

    /// Mark notes as spent in `NoteStore`. Called automatically by
    /// `transfer` / `withdraw` after successful submit. Expose for callers
    /// implementing alternative spend flows.
    async markSpent(noteIds: string[]): Promise<void> {
        const ids = new Set(noteIds);
        this.file.notes.forEach((n) => {
            if (ids.has(n.id)) n.spent = true;
        });
        await this.noteStore.save(this.file);
    }

    /// Self-spend the two smallest notes for `asset` to consolidate them
    /// into a single change note, then re-sync. Called by `transfer` /
    /// `withdraw` when `autoConsolidate: true` is set on
    /// `InsufficientCoverError`.
    ///
    /// Uses `consolidateSum - 1n` as the send amount so a 1-unit change
    /// note pops out (sum-exact targets degenerate into a zero-value change
    /// note that some selectors discard).
    private async autoConsolidate(
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
            // Inner call must NOT recurse — if the selector still can't find
            // a cover for `target`, surface the error instead of looping.
            autoConsolidate: false,
        });
        await this.sync();
    }

    // ---------- internals ----------

    private async resolveFeeBps(): Promise<bigint> {
        return this.cfg.feeBps ?? (await this.cfg.chain.fetchFeeBps());
    }

    private inputsCtx() {
        return { pk: this.keys.pk, nsk: this.keys.nsk, noteSource: this.noteSource };
    }
}
