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
import {
    buildDeposit,
    buildTransfer,
    buildWithdraw,
    type InputSlot,
    type InputSlots,
} from "../bundle.js";
import { buildNullifierFromNsk, type Jubjub, Poseidon } from "../crypto/index.js";
import { buildJubjub } from "../crypto/jubjub-wasm.js";
import { addressFromSpendingKey, buildSpendingKey, type SpendingKey } from "../keys.js";
import type { Note } from "../notes.js";
import type { SpendableCachedNote } from "../witness.js";
import type {
    DepositOptions,
    NotesFilter,
    TransactionResult,
    TransferOptions,
    WalletApi,
    WalletNote,
    WithdrawOptions,
} from "./api.js";
import type { WalletConfig } from "./config.js";
import { defaultNoteSource, defaultProver, defaultSubmitter, validateConfig } from "./defaults.js";
import { InsufficientCoverError } from "./errors.js";
import {
    freshNoteRandomness,
    freshOutput,
    makeTransactionResult,
    toWalletNote,
} from "./internal.js";
import { type KeySource, resolveNsk } from "./key-source.js";
import type { NoteSource } from "./note-source.js";
import {
    decodeStoredNote,
    InMemoryNoteStore,
    type NoteStore,
    type NotesFile,
    type StoredNote,
} from "./note-store.js";
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
    WithdrawOptions,
};

const PERMIT_DEFAULT_DEADLINE_SECS = 3600;

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

    /// Shield ERC20 from caller's eth account into the MASP. Steps:
    /// fetch asset entry + fee, sign EIP-2612 permit, build transact bundle
    /// with one fresh output to `args.to` and one padding output, submit
    /// via `Submitter`. Returns the on-chain tx hash + commitment hashes.
    /// Does NOT touch `NoteStore` — caller should `sync()` afterwards.
    async deposit(args: DepositOptions): Promise<TransactionResult> {
        const asset = args.asset ?? 1n;
        const toAddr = args.to ?? this.address;
        const recipient = decodeAddress(this.J, toAddr);

        const payer = await this.cfg.chain.payerAddress();
        const assetEntry = await this.cfg.chain.fetchAsset(asset);
        const feeBps = await this.cfg.chain.fetchFeeBps();
        const inAmt = args.amount * assetEntry.scale;
        const fee = (inAmt * feeBps) / 10000n;
        const total = inAmt + fee;

        const deadline =
            args.deadline ?? BigInt(Math.floor(Date.now() / 1000) + PERMIT_DEFAULT_DEADLINE_SECS);

        const spender = await this.cfg.chain.maspAddress();

        const permit = await this.cfg.chain.signPermit({
            token: assetEntry.token,
            spender,
            value: total,
            deadline,
        });

        const o0 = freshOutput();
        const o1 = freshNoteRandomness();
        const built = await buildDeposit({
            P: this.P,
            J: this.J,
            chainId: this.cfg.chainId,
            asset,
            payerAddress: payer,
            relayerAddress: this.cfg.relayerAddress,
            recipientAddress: payer,
            prover: this.prover,
            treeDepth: this.cfg.treeDepth,
            publicIn: args.amount,
            recipient,
            output0: { rho: o0.rho, rcm: o0.rcm, rcv: o0.rcv, aux: o0.aux },
            output1Pad: { rho: o1.rho, rcm: o1.rcm, rcv: o1.rcv },
        });

        built.payload.permit = permit;
        const { txHash } = await this.submitter.submit(built.payload);
        return makeTransactionResult({ txHash, built, sent: args.amount, inputSum: 0n });
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

        let selection = this.selectNotes(asset, sendValue, args.selectOpts);
        if (selection.plan === "consolidate-first") {
            if (!args.autoConsolidate) {
                throw new InsufficientCoverError({
                    target: sendValue,
                    asset,
                    consolidate: selection.consolidate,
                    consolidateSum: selection.consolidateSum,
                });
            }
            await this.autoConsolidate(asset, selection);
            selection = this.selectNotes(asset, sendValue, args.selectOpts);
            if (selection.plan === "consolidate-first") {
                throw new InsufficientCoverError({
                    target: sendValue,
                    asset,
                    consolidate: selection.consolidate,
                    consolidateSum: selection.consolidateSum,
                });
            }
        }

        const recipient = decodeAddress(this.J, args.to);
        const ownAddr = decodeAddress(this.J, this.address);
        const inputs = await this.buildInputSlots(selection.notes, asset);

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

        const { txHash } = await this.submitter.submit(built.payload);
        const spent = selection.notes.map((n) => n.id);
        await this.markSpent(spent);
        return makeTransactionResult({
            txHash,
            built,
            spent,
            inputSum: selection.sum,
            sent: sendValue,
            change: changeValue,
        });
    }

    /// Unshield ERC20 to `args.to` (eth address). Selects 1-2 notes,
    /// releases `args.amount` on-chain, splits remainder into two
    /// change-notes back to self, submits, marks spent. Throws
    /// `InsufficientCoverError` on no cover.
    async withdraw(args: WithdrawOptions): Promise<TransactionResult> {
        const asset = args.asset ?? 1n;
        const publicOut = args.amount;

        let selection = this.selectNotes(asset, publicOut, args.selectOpts);
        if (selection.plan === "consolidate-first") {
            if (!args.autoConsolidate) {
                throw new InsufficientCoverError({
                    target: publicOut,
                    asset,
                    consolidate: selection.consolidate,
                    consolidateSum: selection.consolidateSum,
                });
            }
            await this.autoConsolidate(asset, selection);
            selection = this.selectNotes(asset, publicOut, args.selectOpts);
            if (selection.plan === "consolidate-first") {
                throw new InsufficientCoverError({
                    target: publicOut,
                    asset,
                    consolidate: selection.consolidate,
                    consolidateSum: selection.consolidateSum,
                });
            }
        }

        const ownAddr = decodeAddress(this.J, this.address);
        const inputs = await this.buildInputSlots(selection.notes, asset);

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

        const built = await buildWithdraw({
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

    private async buildInputSlots(selected: StoredNote[], asset: bigint): Promise<InputSlots> {
        if (selected.length === 0 || selected.length > 2) {
            throw new Error(`buildInputSlots: expected 1 or 2 notes, got ${selected.length}`);
        }
        const slots: (InputSlot | null)[] = await Promise.all(
            selected.map(async (s): Promise<InputSlot> => {
                const n = decodeStoredNote(s);
                const path = await this.noteSource.fetchPath(n.cm);
                const cached: SpendableCachedNote = {
                    note: {
                        asset,
                        value: n.value,
                        pk: this.keys.pk,
                        rho: n.rho,
                        rcm: n.rcm,
                        rcv: 0n,
                    },
                    nsk: this.keys.nsk,
                    leafIndex: n.leafIndex,
                };
                return { cached, pathElements: path.pathElements, pathIndices: path.pathIndices };
            }),
        );
        while (slots.length < 2) slots.push(null);
        return [slots[0], slots[1]] as InputSlots;
    }
}
