// Locating one MASP operation inside a transaction that may carry several.
//
// A relayer lands operations through its `Bundler` contract, so one tx hash can
// cover several users' spends and does not identify which part belongs to the
// caller. The pool's event layout does: every spend publishes its output
// commitments as `NotePayload.cm`, which the wallet holds. Matching runs on the
// client so the commitments never leave it.
//
// Per item the pool emits, in order (pinned by
// `contracts/test/bundler/Bundler.t.sol::test_execute_mixedBundle_logLayout`):
//
//   transfer        NullifierConsumed×nIn, RootAdvanced, NotePayload×nOut
//   withdraw        NullifierConsumed×nIn, RootAdvanced, AssetMoved, NotePayload×nOut
//   flush           DepositFlushed×n, RootAdvanced
//   swap            the withdraw group, then DepositEscrowed, AssetMoved
//
// Every item advances the root exactly once, so an operation's position in the
// bundle is the position of its `RootAdvanced` among the transaction's.

import type { EvmAddress, Hex32 } from "../core/brand.js";
import type { TxLog } from "./types.js";

/** `keccak256("NotePayload(bytes32,uint256,uint256,uint256,uint256,bytes)")`. */
export const NOTE_PAYLOAD_TOPIC =
    "0x9c97c070d97621a8523b62e1c3d43be0cc098cde21767e1bd2da497cda692772" as Hex32;
/** `keccak256("RootAdvanced(uint64,uint64,bytes32,bytes32)")`. */
export const ROOT_ADVANCED_TOPIC =
    "0x616c77b191d495f23f0e9878ac4c2eec8291e5d6aecc4a1ea1866dcdf3a4495a" as Hex32;
/** `keccak256("NullifierConsumed(bytes32)")`. */
export const NULLIFIER_CONSUMED_TOPIC =
    "0x6159549712b421860b1a73100a45b4216017d27fe478a58c386f8ced10b7e1b7" as Hex32;

/** Where one operation sits in the transaction that landed it. */
export interface OperationLocation {
    /**
     * 0-based position among the pool operations in the transaction: the
     * number of `RootAdvanced` logs before this operation's own.
     */
    index: number;
    /**
     * Pool operations in the transaction — its `RootAdvanced` count. `1` for a
     * transaction that landed this operation alone.
     */
    count: number;
    /**
     * Inclusive positions in the receipt's `logs` array, from the operation's
     * first `NullifierConsumed` through its last `NotePayload`.
     */
    logRange: [number, number];
}

/** Positions in `logs` of the operation that published one of the wanted commitments. */
interface OperationScan {
    /** The operation's first `NullifierConsumed`, or `root` when none leads it. */
    start: number;
    /** The operation's `RootAdvanced`. */
    root: number;
    /** `RootAdvanced` logs before `root`. */
    rootIndex: number;
    /** `RootAdvanced` logs in the transaction. */
    count: number;
    /** First and last matching `NotePayload`. */
    first: number;
    last: number;
}

/** Whether `pool` (lowercase) emitted `l`, and as the event `topic`. */
function isPoolEvent(l: TxLog, pool: string, topic: Hex32): boolean {
    return l.address.toLowerCase() === pool && l.topics[0]?.toLowerCase() === topic;
}

/** The operation {@link locateOperation} finds, as positions in `logs`. */
function scanOperation(
    logs: readonly TxLog[],
    pool: string,
    commitments: readonly string[],
): OperationScan | undefined {
    const poolAddr = pool.toLowerCase();
    const wanted = new Set(commitments.map((c) => c.toLowerCase()));
    if (wanted.size === 0) return undefined;

    const isOwnPayload = (l: TxLog) =>
        isPoolEvent(l, poolAddr, NOTE_PAYLOAD_TOPIC) &&
        wanted.has(l.topics[1]?.toLowerCase() ?? "");

    let count = 0;
    let root = -1;
    let rootIndex = -1;
    let first = -1;
    let last = -1;
    for (let i = 0; i < logs.length; i++) {
        const l = logs[i] as TxLog;
        if (isPoolEvent(l, poolAddr, ROOT_ADVANCED_TOPIC)) {
            // After the matched payloads, a later root belongs to a later operation.
            if (first === -1) {
                root = i;
                rootIndex = count;
            }
            count++;
        } else if (isOwnPayload(l)) {
            if (first === -1) first = i;
            last = i;
        }
    }
    if (first === -1 || root === -1) return undefined;

    // The nullifiers lead the root directly; walk back over them. A log from
    // another contract ends the run, as nothing is emitted between them.
    let start = root;
    while (start > 0 && isPoolEvent(logs[start - 1] as TxLog, poolAddr, NULLIFIER_CONSUMED_TOPIC)) {
        start--;
    }

    return { start, root, rootIndex, count, first, last };
}

/**
 * Find the operation that published `commitments` among `logs`.
 *
 * `commitments` are the operation's output commitments, as `bytes32` hex. Its
 * `RootAdvanced` is the last one before its first matching `NotePayload`.
 * `undefined` when no `NotePayload` from `pool` carries one of them, or none is
 * preceded by a `RootAdvanced`; the pool produces neither layout for a spend.
 */
export function locateOperation(
    logs: readonly TxLog[],
    pool: EvmAddress | string,
    commitments: readonly string[],
): OperationLocation | undefined {
    const op = scanOperation(logs, pool, commitments);
    if (!op) return undefined;
    return { index: op.rootIndex, count: op.count, logRange: [op.start, op.last] };
}

/**
 * Find the output that published `commitment` among `logs`: the nullifiers of its spend and its
 * slot among that spend's outputs. `nullifiers[0]` and `index` fix the output note's
 * `rho = Poseidon(TAG_RHO, nullifiers[0], index)`.
 *
 * `nullifiers` are `topics[1]` of the operation's `NullifierConsumed` logs. The pool emits one per
 * input slot, dummies included, in slot order, so they are the spend's public nullifier signals.
 * `index` counts the operation's `NotePayload` logs before the one carrying `commitment`. Both
 * read the pool's logs of that operation alone, so another operation bundled into the transaction
 * contributes to neither.
 *
 * `undefined` when the pool published no such commitment in a spend: {@link locateOperation}
 * finds no operation, or a `NullifierConsumed` carrying a nullifier does not lead its root.
 */
export function locateOutput(
    logs: readonly TxLog[],
    pool: EvmAddress | string,
    commitment: string,
): { nullifiers: Hex32[]; index: number } | undefined {
    const op = scanOperation(logs, pool, [commitment]);
    if (!op) return undefined;
    const nullifiers = logs.slice(op.start, op.root).map((l) => l.topics[1]);
    const complete = nullifiers.every((nf): nf is Hex32 => nf !== undefined);
    if (nullifiers.length === 0 || !complete) return undefined;

    const poolAddr = pool.toLowerCase();
    const index = logs
        .slice(op.root + 1, op.first)
        .filter((l) => isPoolEvent(l, poolAddr, NOTE_PAYLOAD_TOPIC)).length;
    return { nullifiers, index };
}

/**
 * Whether `logs` show `pool` inserting `commitment` into its tree: a
 * `NotePayload` carrying it, from the pool, after a `RootAdvanced`.
 *
 * This is the pool's own word, read from a receipt, where a note feed is an
 * indexer's. A deposit's `DepositEscrowed` does not count: an escrow is not in
 * the tree until flushed and can still be cancelled.
 */
export function commitmentPublished(
    logs: readonly TxLog[],
    pool: EvmAddress | string,
    commitment: string,
): boolean {
    return locateOperation(logs, pool, [commitment]) !== undefined;
}
