// A self-transfer over pinned notes, as consolidation and re-denomination run it.

import {
    type AssetId,
    branded,
    type CircuitAmount,
    type ShieldedAddress,
} from "../../core/brand.js";
import type { TransferOptions } from "../types/options.js";
import type { TransferResult } from "../types/results.js";

/** The slice of a wallet a self-transfer drives. */
export interface SelfTransferHost {
    /** Own shielded address; the transfer pays it. */
    readonly address: ShieldedAddress;
    /** Input arity of the configured circuit: every slot may be used. */
    readonly maxInputs: number;
    transfer(args: TransferOptions): Promise<TransferResult>;
    awaitCommitments(cms: string[]): Promise<unknown>;
}

/**
 * Transfer `amount` of `asset` to self, spending only the notes named by `only`.
 *
 * Pinned because, given only an amount, the selector could cover it with one large note and
 * reshape none of the notes the caller meant. Never auto-consolidates: this is what consolidation
 * itself runs, and it must not recurse.
 */
export function selfTransfer(
    host: SelfTransferHost,
    args: { asset: bigint; amount: bigint; only: string[] },
): Promise<TransferResult> {
    return host.transfer({
        recipient: host.address,
        amount: branded<CircuitAmount>(args.amount),
        asset: branded<AssetId>(args.asset),
        selection: { only: args.only, maxInputs: host.maxInputs },
        autoConsolidate: false,
    });
}

/** Poll until the wallet has stored the notes `result` paid back to itself. */
export function awaitOwnNotes(host: SelfTransferHost, result: TransferResult): Promise<unknown> {
    return host.awaitCommitments([...result.ownCommitments]);
}
