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

/** `keccak256("NotePayload(bytes32,uint256,uint256,uint256,uint256,bytes,uint256,uint256)")`. */
export const NOTE_PAYLOAD_TOPIC =
    "0x08829d53b88cc31ed8597c58d2cc3202054ab57e9ab21b258aec2ae0974aa8d7" as Hex32;
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
    const poolAddr = pool.toLowerCase();
    const wanted = new Set(commitments.map((c) => c.toLowerCase()));
    if (wanted.size === 0) return undefined;

    const fromPool = (l: TxLog) => l.address.toLowerCase() === poolAddr;
    const topic0 = (l: TxLog) => l.topics[0]?.toLowerCase();
    const isOwnPayload = (l: TxLog) =>
        fromPool(l) &&
        topic0(l) === NOTE_PAYLOAD_TOPIC &&
        wanted.has(l.topics[1]?.toLowerCase() ?? "");

    let count = 0;
    let root = -1;
    let rootIndex = -1;
    let first = -1;
    let last = -1;
    for (let i = 0; i < logs.length; i++) {
        const l = logs[i] as TxLog;
        if (fromPool(l) && topic0(l) === ROOT_ADVANCED_TOPIC) {
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
    while (start > 0) {
        const prev = logs[start - 1] as TxLog;
        if (!fromPool(prev) || topic0(prev) !== NULLIFIER_CONSUMED_TOPIC) break;
        start--;
    }

    return { index: rootIndex, count, logRange: [start, last] };
}
