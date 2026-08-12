// The narrow surface a transaction executor needs.
//
// `executeDeposit`, `executeTransfer`, `executeWithdraw` and `executeSwap`
// depend on this rather than on `Wallet`, so none of them needs a real wallet
// (wasm, chain adapter, prover, note store) to run. `Wallet` implements it in
// a few lines; a test satisfies it with an object literal.

import type { Field, Jubjub, Poseidon } from "../crypto/index.js";
import type { SpendingKey } from "../keys/keys.js";
import type { Prover } from "../prover/types.js";
import type { ResolvedWalletConfig } from "./config.js";
import type { StoredNote } from "./note-store.js";
import type { CoinSelector, SelectionResult } from "./selection.js";
import type { Submitter } from "./submitter.js";
import type { TreeStore } from "./tree-store.js";

export interface SpendContext {
    readonly P: Poseidon;
    readonly J: Jubjub;
    readonly keys: SpendingKey;
    /** Own bech32m shielded address. */
    readonly address: string;
    readonly cfg: ResolvedWalletConfig;

    readonly prover: Prover;
    readonly submitter: Submitter;
    readonly selector: CoinSelector;
    readonly treeStore: TreeStore;

    /**
     * The raw stored-note list.
     *
     * Named apart from `Wallet.notes(filter)`, which is the public,
     * filtered, decoded query — these are two different views.
     */
    storedNotes(): readonly StoredNote[];
    markSpent(ids: string[]): Promise<void>;
    /** Self-spend two notes into one so a 2-note cover becomes available. */
    autoConsolidate(asset: bigint, selection: SelectionResult): Promise<void>;
    /** Config override, else the chain's current fee. */
    feeBps(): Promise<bigint>;
}

/** Inputs `buildInputSlots` needs. Derived, so callers cannot get it wrong. */
export function inputsCtx(ctx: SpendContext): {
    pk: Field;
    nsk: Field;
    treeStore: TreeStore;
    nIn: number;
} {
    return {
        pk: ctx.keys.pk,
        nsk: ctx.keys.nsk,
        treeStore: ctx.treeStore,
        nIn: ctx.cfg.shape.nIn,
    };
}
