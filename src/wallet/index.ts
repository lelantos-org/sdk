// High-level Wallet. Owns keys + in-memory note cache; every external
// dependency (ChainAdapter, NoteSource, Submitter, Prover, CoinSelector,
// NoteStore) is injected.

import { decodeAddress } from "../address.js";
import { buildDeposit, buildTransfer, buildWithdraw, buildWithdrawNative } from "../bundle.js";
import { buildNullifierFromNsk, type Jubjub, Poseidon } from "../crypto/index.js";
import { buildJubjub } from "../crypto/jubjub-wasm.js";
import { addressFromSpendingKey, buildSpendingKey, type SpendingKey } from "../keys.js";
import type { Note } from "../notes.js";
import { computePiHash } from "../permit2.js";
import type { SubmitSwapPayload } from "../relayer.js";
import type {
    DepositOptions,
    NotesFilter,
    SwapOptions,
    TransactionResult,
    TransferOptions,
    WalletApi,
    WalletNote,
    WalletNotePayload,
    WithdrawEthOptions,
    WithdrawOptions,
} from "./api.js";
import { supportsAllowanceTransfer, supportsNativeEth } from "./chain-adapter.js";
import type { WalletConfig } from "./config.js";
import { ensureCover } from "./cover.js";
import { defaultNoteSource, defaultProver, defaultSubmitter, validateConfig } from "./defaults.js";
import { DepositAdapterError, type DepositStrategy } from "./errors.js";
import { buildInputSlots } from "./inputs.js";
import {
    auxOutputToTransactAux,
    freshNoteRandomness,
    freshOutput,
    makeTransactionResult,
    toWalletNote,
} from "./internal.js";
import { hexPrivateKeyToNsk, type KeySource, resolveNsk } from "./key-source.js";
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

export type {
    DepositOptions,
    NotesFilter,
    SwapOptions,
    TransactionResult,
    TransferOptions,
    WalletApi,
    WalletNote,
    WalletNotePayload,
    WithdrawEthOptions,
    WithdrawOptions,
};

const PERMIT2_DEFAULT_DEADLINE_SECS = 3600;
/// Refuse allowance windows expiring within this many seconds; avoids
/// racing past expiration mid-tx.
const ALLOWANCE_BUFFER_SECS = 60;

/// Swallow callback errors so a misbehaving listener can't break a tx.
function safePhase<P>(cb: ((p: P) => void) | undefined, phase: P): void {
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
    private file: NotesFile;

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
        const { deriveNskFromSigner } = await import("../metamask.js");
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

    /// Mark locally-unspent notes whose nullifiers are already consumed
    /// on chain; single batch via `noteSource.spentSet`.
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

    /// Shield ERC-20 into the MASP via Permit2 escrow. Funds sit in
    /// escrow until the relayer flushes a batch (or `cancelIntent` after
    /// `cancelDelay` blocks). For native ETH set `asEth: true`.
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
            output0: {
                rho: o0.rho,
                rcm: o0.rcm,
                rcv: o0.rcv,
                rcvDep: o0.rcvDep,
                aux: o0.aux,
            },
            output1Pad: {
                rho: o1.rho,
                rcm: o1.rcm,
                rcv: o1.rcv,
                rcvDep: o1.rcvDep,
            },
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
            // Both outputs credited to depositor's own shielded address.
            ownIndices: [0, 1],
        });
        return { ...result, intentId };
    }

    /// Order: native ETH > AllowanceTransfer > witness (fallback).
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

    /// Every branch returns the same `{ txHash, intentId }` shape.
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

        // `broadcast` fires once the wallet returns a tx hash (user signed,
        // tx in mempool); the awaited `tx.wait()` then resolves and we emit
        // `mined`. Splits the otherwise-opaque submit gap into three steps
        // for the form's progress UI.
        const onSent = () => safePhase(args.onPhase, "broadcast");
        const emitMined = (r: { txHash: string; intentId: bigint }) => {
            safePhase(args.onPhase, "mined");
            return r;
        };

        if (strategy === "native") {
            safePhase(args.onPhase, "submitting");
            return chain.submitIntentNative!({
                intent: built.intent,
                aux: built.aux,
                value: total,
                onSent,
            }).then(emitMined);
        }
        if (strategy === "allowance") {
            safePhase(args.onPhase, "submitting");
            return chain.submitIntentAuthorized!({
                intent: built.intent,
                aux: built.aux,
                onSent,
            }).then(emitMined);
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
            // Relayer-broadcast path: the submitter posts to the relayer and
            // receives the hash back. Emit `broadcast` once the request
            // resolves with a hash, then `mined` after the on-chain receipt
            // surfaces upstream. For now we treat the submitter return as
            // the broadcast point.
            const r = await this.submitter.submitIntent({
                chainId: this.cfg.chainId,
                intent: built.intent,
                permit2,
                aux: built.aux,
            });
            safePhase(args.onPhase, "broadcast");
            safePhase(args.onPhase, "mined");
            return r;
        }
        return chain.submitIntent!({ intent: built.intent, permit2, aux: built.aux, onSent }).then(
            emitMined,
        );
    }

    /// Recompute the total the strategy picker compares to the allowance
    /// window. Reads are cheap/cached.
    private async computeDepositTotal(args: DepositOptions, _token: string): Promise<bigint> {
        const asset = args.asset ?? 1n;
        const entry = await this.cfg.chain.fetchAsset(asset);
        const feeBps = await this.resolveFeeBps();
        const inAmt = args.amount * entry.scale;
        return inAmt + (inAmt * feeBps) / 10000n;
    }

    /// Cancel an escrowed deposit. Permissionless after `cancelDelay`
    /// blocks. Caller supplies the `IntentEscrowed` event payload for the
    /// on-chain digest check.
    async cancelIntent(
        id: bigint,
        inputs: import("./chain-adapter.js").CancelIntentInputs,
    ): Promise<{ txHash: string }> {
        if (!this.cfg.chain.cancelIntent) {
            throw new DepositAdapterError("witness", ["cancelIntent"]);
        }
        return this.cfg.chain.cancelIntent(id, inputs);
    }

    /// Shielded transfer: 1-2 notes → send-note + change-note → submit →
    /// mark spent. Throws `InsufficientCoverError` on no 1/2-note cover.
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
            rcvDep: randomJubjubScalar(),
        };
        const changeNote: Note = {
            asset,
            value: changeValue,
            pk: this.keys.pk,
            rho: randomFr(),
            rcm: randomFr(),
            rcv: randomJubjubScalar(),
            rcvDep: randomJubjubScalar(),
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
        // Output 0 = recipient (own only if self-transfer); output 1 = change.
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

    /// Unshield ERC20 to `args.to`. Throws `InsufficientCoverError` on no cover.
    async withdraw(args: WithdrawOptions): Promise<TransactionResult> {
        return this.withdrawCore({ ...args, asset: args.asset ?? 1n }, "withdraw");
    }

    /// Unshield to raw ETH via `MASP.withdrawNative`; MASP unwraps WETH.
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
            rcvDep: randomJubjubScalar(),
        };
        const change1: Note = {
            asset,
            value: remainder - half,
            pk: this.keys.pk,
            rho: randomFr(),
            rcm: randomFr(),
            rcv: randomJubjubScalar(),
            rcvDep: randomJubjubScalar(),
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

    /// Atomic shielded swap. Leg-1 transact_2x2 unshields to SwapWrapper;
    /// leg-2 deposit intent re-shields the B note. Bundled via
    /// `submitter.submitSwap`. `args.amount` is gross publicOut in circuit
    /// units of `assetIn`; MASP skims `feeBps` before transferring.
    async swap(args: SwapOptions): Promise<TransactionResult> {
        if (!this.submitter.submitSwap) {
            throw new Error("swap: submitter does not implement submitSwap");
        }
        if (args.assetIn === args.assetOut) {
            throw new Error("swap: assetIn must differ from assetOut");
        }

        const { assetIn, assetOut, quote, wrapperAddress } = args;
        const feeBps = await this.resolveFeeBps();
        const fee = (args.amount * feeBps) / 10000n;
        const publicOut = args.amount + fee;

        safePhase(args.onPhase, "preparing");
        const selection = await ensureCover(
            this.selector,
            () => this.file.notes,
            {
                asset: assetIn,
                target: publicOut,
                selectOpts: args.selectOpts,
                autoConsolidate: args.autoConsolidate,
            },
            (a, sel) => this.autoConsolidate(a, sel),
        );

        const ownAddr = decodeAddress(this.J, this.address);
        const bRecipient = decodeAddress(this.J, args.bRecipient ?? this.address);
        const inputs = await buildInputSlots(this.inputsCtx(), selection.notes, assetIn);

        const remainder = selection.sum - publicOut;
        const half = remainder / 2n;
        const change0: Note = {
            asset: assetIn,
            value: half,
            pk: this.keys.pk,
            rho: randomFr(),
            rcm: randomFr(),
            rcv: randomJubjubScalar(),
            rcvDep: randomJubjubScalar(),
        };
        const change1: Note = {
            asset: assetIn,
            value: remainder - half,
            pk: this.keys.pk,
            rho: randomFr(),
            rcm: randomFr(),
            rcv: randomJubjubScalar(),
            rcvDep: randomJubjubScalar(),
        };

        const merkleRoot = (await this.noteSource.fetchPath(selection.notes[0].cm)).root;

        const [entryIn, entryOut] = await Promise.all([
            this.cfg.chain.fetchAsset(assetIn),
            this.cfg.chain.fetchAsset(assetOut),
        ]);

        // B-note value bounded so the wrapper covers the Permit2 pull:
        // `bValue * scaleOut * (10_000 + feeBps) / 10_000 ≤ minOut`.
        // Floor-div remainder becomes wrapper-side dust to treasury.
        const bValue = (quote.minOut * 10_000n) / (entryOut.scale * (10_000n + feeBps));
        if (bValue <= 0n) {
            throw new Error(`swap: minOut ${quote.minOut} below scaleOut*(1+fee) (zero B-note)`);
        }

        safePhase(args.onPhase, "proving");
        // Leg 1: withdraw → wrapper. MASP enforces `pi.relayer == msg.sender`.
        const built = await buildWithdraw({
            P: this.P,
            J: this.J,
            chainId: this.cfg.chainId,
            asset: assetIn,
            payerAddress: wrapperAddress,
            relayerAddress: wrapperAddress,
            recipientAddress: wrapperAddress,
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

        // Leg 2: B-note deposit intent. Slot 0 = real B note, slot 1 = pad.
        const o0 = freshOutput();
        const o1 = freshNoteRandomness();
        const intentBundle = buildDeposit({
            P: this.P,
            J: this.J,
            chainId: this.cfg.chainId,
            asset: assetOut,
            payerAddress: wrapperAddress,
            recipientAddress: wrapperAddress,
            publicIn: bValue,
            recipient: bRecipient,
            output0: {
                rho: o0.rho,
                rcm: o0.rcm,
                rcv: o0.rcv,
                rcvDep: o0.rcvDep,
                aux: o0.aux,
            },
            output1Pad: {
                rho: o1.rho,
                rcm: o1.rcm,
                rcv: o1.rcv,
                rcvDep: o1.rcvDep,
            },
        });

        // MASP skims fee off gross before transferring to wrapper.
        const grossIn = publicOut * entryIn.scale;
        const feeIn = (grossIn * feeBps) / 10000n;
        const amountInUnits = grossIn - feeIn;

        const payload: SubmitSwapPayload = {
            chainId: this.cfg.chainId,
            proof2x2: built.payload.proof2x2,
            pubInputs: built.payload.pubInputs,
            aux: built.payload.aux,
            swap: {
                adapter: quote.adapter,
                route: quote.route,
                intentD: intentBundle.intent,
                auxD: [
                    auxOutputToTransactAux(intentBundle.aux[0]),
                    auxOutputToTransactAux(intentBundle.aux[1]),
                ],
                tokenIn: entryIn.token,
                tokenOut: entryOut.token,
                amountIn: amountInUnits,
                minOut: quote.minOut,
            },
        };

        safePhase(args.onPhase, "submitting");
        const { txHash } = await this.submitter.submitSwap(payload);
        const spent = selection.notes.map((n) => n.id);
        await this.markSpent(spent);

        // B note materialises asynchronously via the relayer's flushBatch;
        // only leg-1 change commitments surface here.
        return makeTransactionResult({
            txHash,
            built,
            spent,
            inputSum: selection.sum,
            sent: publicOut,
            change: remainder,
            ownIndices: [0, 1],
        });
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

    /// Self-spend the two smallest notes for `asset` into one change note.
    /// Sends `consolidateSum - 1n` so a 1-unit change note pops out (some
    /// selectors discard zero-value change).
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
            // Inner call must NOT recurse.
            autoConsolidate: false,
        });
        await this.sync();
    }

    private async resolveFeeBps(): Promise<bigint> {
        return this.cfg.feeBps ?? (await this.cfg.chain.fetchFeeBps());
    }

    private inputsCtx() {
        return { pk: this.keys.pk, nsk: this.keys.nsk, noteSource: this.noteSource };
    }
}
