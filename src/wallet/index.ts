// High-level Wallet — primary integration surface for `@lelantos/sdk`.
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

import {
    Poseidon,
    Jubjub,
    type Field,
} from "../crypto/index";
import {
    buildSpendingKey,
    addressFromSpendingKey,
    type SpendingKey,
} from "../keys";
import { decodeAddress } from "../address";
import {
    buildDeposit,
    buildTransfer,
    buildWithdraw,
    type InputSlot,
    type InputSlots,
    type BuiltBundle,
} from "../bundle";
import type { SpendableCachedNote } from "../witness";
import type { Note } from "../notes";
import { resolveNsk, type KeySource } from "./key-source";
import { randomFr, randomJubjubScalar } from "./randomness";
import {
    SfrtCoinSelector,
    type CoinSelector,
    type SelectionResult,
    type SelectOpts,
} from "./selection";
import { FmdClient } from "./fmd-client";
import { FmdNoteSource, type NoteSource } from "./note-source";
import { HttpRelayerSubmitter, type Submitter } from "./submitter";
import { SnarkjsProver, type Prover } from "./prover";
import {
    InMemoryNoteStore,
    addHits,
    type NotesFile,
    type StoredNote,
    type NoteStore,
} from "./note-store";
import { syncWallet, type SyncResult } from "./sync";
import type { WalletConfig } from "./config";

export interface DepositOptions {
    amount: bigint;
    asset?: bigint;
    /// Shielded recipient. Defaults to own address (deposit to self).
    to?: string;
    /// Permit deadline override; default = now + 3600.
    deadline?: bigint;
}

export interface TransferOptions {
    /// Recipient bech32m shielded address (any wallet, including own).
    to: string;
    amount: bigint;
    asset?: bigint;
    selectOpts?: SelectOpts;
}

export interface WithdrawOptions {
    /// On-chain ETH recipient (0x address).
    to: string;
    amount: bigint;
    asset?: bigint;
    selectOpts?: SelectOpts;
}

export interface TxResult {
    txHash: string;
    cm: [string, string];                       // 0x-hex
    spentNoteIds?: string[];
    inputSum?: bigint;
    sent?: bigint;
    change?: bigint;
}

/// Public interface — apps can mock this in tests, or build alternative
/// implementations (HSM-backed wallet, multi-sig, MPC) without subclassing.
export interface WalletApi {
    readonly address: string;
    readonly keys: SpendingKey;

    sync(opts?: { limit?: number }): Promise<SyncResult>;
    refresh(): Promise<void>;
    notes(filter?: { asset?: bigint; spent?: boolean }): StoredNote[];
    balance(asset: bigint): bigint;
    selectNotes(asset: bigint, target: bigint, opts?: SelectOpts): SelectionResult;

    deposit(args: DepositOptions): Promise<TxResult>;
    transfer(args: TransferOptions): Promise<TxResult>;
    withdraw(args: WithdrawOptions): Promise<TxResult>;
    markSpent(noteIds: string[]): Promise<void>;
}

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
    private file: NotesFile;

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
    }

    /// Build a wallet from any key source. Wires defaults for any
    /// pluggable not supplied in `cfg`.
    static async create(source: KeySource, cfg: WalletConfig): Promise<Wallet> {
        const P = await Poseidon.build();
        const J = await Jubjub.build();
        const nsk = resolveNsk(source);
        const keys = buildSpendingKey(P, J, nsk);
        const address = addressFromSpendingKey(J, keys);

        const noteStore = cfg.noteStore ?? new InMemoryNoteStore();
        const file = await noteStore.load();

        const noteSource = cfg.noteSource ?? defaultNoteSource(cfg, J);
        const submitter = cfg.submitter ?? defaultSubmitter(cfg);
        const prover = cfg.prover ?? defaultProver(cfg);
        const selector = cfg.selector ?? new SfrtCoinSelector();

        return new Wallet({
            P, J, keys, address,
            cfg: { ...cfg, noteStore, noteSource, submitter, prover, selector },
            file,
            noteStore, noteSource, submitter, prover, selector,
        });
    }

    // ---------- cache + sync ----------

    async sync(opts?: { limit?: number }): Promise<SyncResult> {
        const result = await syncWallet(
            { J: this.J, ivk: this.keys.ivk, dk: this.keys.dk, source: this.noteSource, store: this.noteStore },
            opts ?? {},
        );
        this.file = await this.noteStore.load();
        return result;
    }

    async refresh(): Promise<void> {
        this.file = await this.noteStore.load();
    }

    notes(filter?: { asset?: bigint; spent?: boolean }): StoredNote[] {
        return this.file.notes.filter((n) => {
            if (filter?.spent !== undefined && n.spent !== filter.spent) return false;
            if (filter?.asset !== undefined && BigInt(n.asset) !== filter.asset) return false;
            return true;
        });
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

    async deposit(args: DepositOptions): Promise<TxResult> {
        const asset = args.asset ?? 1n;
        const toAddr = args.to ?? this.address;
        const recipient = decodeAddress(this.J, toAddr);

        const payer = await this.cfg.chain.payerAddress();
        const assetEntry = await this.cfg.chain.fetchAsset(asset);
        const feeBps = await this.cfg.chain.fetchFeeBps();
        const inAmt = args.amount * assetEntry.scale;
        const fee = (inAmt * feeBps) / 10000n;
        const total = inAmt + fee;

        const deadline = args.deadline
            ?? BigInt(Math.floor(Date.now() / 1000) + PERMIT_DEFAULT_DEADLINE_SECS);

        const spender = (this.cfg.chain as { maspAddr?: string }).maspAddr;
        if (!spender) {
            throw new Error("ChainAdapter must expose `maspAddr` for permit-spender lookup");
        }

        const permit = await this.cfg.chain.signPermit({
            token: assetEntry.token,
            spender,
            value: total,
            deadline,
        });

        const o0 = freshOutput();
        const o1 = freshNoteRandomness();
        const built = await buildDeposit({
            P: this.P, J: this.J,
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
        return makeTxResult(txHash, built);
    }

    async transfer(args: TransferOptions): Promise<TxResult> {
        const asset = args.asset ?? 1n;
        const sendValue = args.amount;

        const selection = this.selectNotes(asset, sendValue, args.selectOpts);
        if (selection.plan === "consolidate-first") {
            throw consolidateError(sendValue, asset, selection);
        }

        const recipient = decodeAddress(this.J, args.to);
        const ownAddr = decodeAddress(this.J, this.address);
        const inputs = await this.buildInputSlots(selection.notes, asset);

        const changeValue = selection.sum - sendValue;
        const sendNote: Note = {
            asset, value: sendValue, pk: recipient.pk,
            rho: randomFr(), rcm: randomFr(), rcv: randomJubjubScalar(),
        };
        const changeNote: Note = {
            asset, value: changeValue, pk: this.keys.pk,
            rho: randomFr(), rcm: randomFr(), rcv: randomJubjubScalar(),
        };

        const merkleRoot = (await this.noteSource.fetchPath(selection.notes[0].cm)).root;

        const built = await buildTransfer({
            P: this.P, J: this.J,
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
        await this.markSpent(selection.notes.map((n) => n.id));
        const result = makeTxResult(txHash, built);
        result.spentNoteIds = selection.notes.map((n) => n.id);
        result.inputSum = selection.sum;
        result.sent = sendValue;
        result.change = changeValue;
        return result;
    }

    async withdraw(args: WithdrawOptions): Promise<TxResult> {
        const asset = args.asset ?? 1n;
        const publicOut = args.amount;

        const selection = this.selectNotes(asset, publicOut, args.selectOpts);
        if (selection.plan === "consolidate-first") {
            throw consolidateError(publicOut, asset, selection);
        }

        const ownAddr = decodeAddress(this.J, this.address);
        const inputs = await this.buildInputSlots(selection.notes, asset);

        const remainder = selection.sum - publicOut;
        const half = remainder / 2n;
        const change0: Note = {
            asset, value: half, pk: this.keys.pk,
            rho: randomFr(), rcm: randomFr(), rcv: randomJubjubScalar(),
        };
        const change1: Note = {
            asset, value: remainder - half, pk: this.keys.pk,
            rho: randomFr(), rcm: randomFr(), rcv: randomJubjubScalar(),
        };

        const merkleRoot = (await this.noteSource.fetchPath(selection.notes[0].cm)).root;

        const built = await buildWithdraw({
            P: this.P, J: this.J,
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
        await this.markSpent(selection.notes.map((n) => n.id));
        const result = makeTxResult(txHash, built);
        result.spentNoteIds = selection.notes.map((n) => n.id);
        result.inputSum = selection.sum;
        result.sent = publicOut;
        result.change = remainder;
        return result;
    }

    async markSpent(noteIds: string[]): Promise<void> {
        const ids = new Set(noteIds);
        for (const n of this.file.notes) if (ids.has(n.id)) n.spent = true;
        await this.noteStore.save(this.file);
    }

    // ---------- internals ----------

    private async buildInputSlots(
        selected: StoredNote[],
        asset: bigint,
    ): Promise<InputSlots> {
        if (selected.length === 0 || selected.length > 2) {
            throw new Error(`buildInputSlots: expected 1 or 2 notes, got ${selected.length}`);
        }
        const slots: (InputSlot | null)[] = await Promise.all(
            selected.map(async (n): Promise<InputSlot> => {
                const path = await this.noteSource.fetchPath(n.cm);
                const cached: SpendableCachedNote = {
                    note: {
                        asset,
                        value: BigInt(n.value),
                        pk: this.keys.pk,
                        rho: BigInt(n.rho),
                        rcm: BigInt(n.rcm),
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

// ---------- defaults ----------

function defaultNoteSource(cfg: WalletConfig, J: Jubjub): NoteSource {
    if (!cfg.fmdUrl) {
        throw new Error("WalletConfig: provide `fmdUrl` or `noteSource`");
    }
    return new FmdNoteSource({ fmd: new FmdClient(cfg.fmdUrl, cfg.chainId), J });
}

function defaultSubmitter(cfg: WalletConfig): Submitter {
    if (!cfg.relayerUrl) {
        throw new Error("WalletConfig: provide `relayerUrl` or `submitter`");
    }
    return new HttpRelayerSubmitter(cfg.relayerUrl);
}

function defaultProver(cfg: WalletConfig): Prover {
    if (!cfg.proverPaths) {
        throw new Error("WalletConfig: provide `proverPaths` or `prover`");
    }
    return new SnarkjsProver(cfg.proverPaths);
}

// ---------- helpers ----------

interface OutputRandomness {
    rho: Field;
    rcm: Field;
    rcv: Field;
    aux: { esk: Field; fmdR: Field };
}

function freshOutput(): OutputRandomness {
    return {
        rho: randomFr(),
        rcm: randomFr(),
        rcv: randomJubjubScalar(),
        aux: { esk: randomJubjubScalar(), fmdR: randomJubjubScalar() },
    };
}

function freshNoteRandomness(): { rho: Field; rcm: Field; rcv: Field } {
    return { rho: randomFr(), rcm: randomFr(), rcv: randomJubjubScalar() };
}

function makeTxResult(txHash: string, built: BuiltBundle): TxResult {
    return {
        txHash,
        cm: [
            "0x" + built.cm[0].toString(16).padStart(64, "0"),
            "0x" + built.cm[1].toString(16).padStart(64, "0"),
        ],
    };
}

function consolidateError(
    target: bigint,
    asset: bigint,
    selection: { consolidate: { id: string }[]; consolidateSum: bigint },
): Error {
    return new Error(
        `insufficient 2-note cover for ${target} (asset ${asset}); ` +
        `consolidate two smallest notes first ` +
        `(ids: ${selection.consolidate.map((n) => n.id).join(", ")}, ` +
        `sum: ${selection.consolidateSum}), then re-run`,
    );
}
