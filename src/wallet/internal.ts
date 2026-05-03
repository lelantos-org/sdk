// Private helpers used by the `Wallet` class. Kept separate so the class
// file reads top-to-bottom as flow, not as flow + utility soup.

import type { BuiltBundle } from "../bundle.js";
import type { Field } from "../crypto/index.js";
import type { TransactionResult, WalletNote } from "./api.js";
import type { StoredNote } from "./note-store.js";
import { randomFr, randomJubjubScalar } from "./randomness.js";

/// Deposit's slot-0 randomness: rho/rcm/rcv plus FMD aux randomness.
export interface OutputRandomness {
    rho: Field;
    rcm: Field;
    rcv: Field;
    aux: { esk: Field; fmdR: Field };
}

export function freshOutput(): OutputRandomness {
    return {
        rho: randomFr(),
        rcm: randomFr(),
        rcv: randomJubjubScalar(),
        aux: { esk: randomJubjubScalar(), fmdR: randomJubjubScalar() },
    };
}

export function freshNoteRandomness(): { rho: Field; rcm: Field; rcv: Field } {
    return { rho: randomFr(), rcm: randomFr(), rcv: randomJubjubScalar() };
}

/// Lift a `StoredNote` (decimal strings, hex) to the friendlier
/// `WalletNote` view (bigints, with a `.raw` escape hatch).
export function toWalletNote(s: StoredNote): WalletNote {
    return {
        id: s.id,
        asset: BigInt(s.asset),
        value: BigInt(s.value),
        spent: s.spent,
        firstSeenBlock: s.firstSeenBlock,
        discoveredAt: s.discoveredAt,
        cm: s.cm,
        raw: s,
    };
}

export interface MakeTransactionResultArgs {
    txHash: string;
    built: BuiltBundle;
    spent?: string[];
    inputSum?: bigint;
    sent?: bigint;
    change?: bigint;
}

export function makeTransactionResult(args: MakeTransactionResultArgs): TransactionResult {
    const commitments: [string, string] = [
        `0x${args.built.cm[0].toString(16).padStart(64, "0")}`,
        `0x${args.built.cm[1].toString(16).padStart(64, "0")}`,
    ];
    const spent = args.spent ?? [];
    return {
        txHash: args.txHash,
        commitments,
        spent,
        inputSum: args.inputSum ?? 0n,
        sent: args.sent ?? 0n,
        change: args.change ?? 0n,
        // Back-compat aliases — populated even though the new fields are
        // canonical, so old callers reading `.cm` / `.spentNoteIds` keep
        // working until they migrate.
        cm: commitments,
        spentNoteIds: spent,
    };
}
