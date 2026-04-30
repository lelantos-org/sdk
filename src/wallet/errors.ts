// Typed error classes thrown by the high-level Wallet API.
// Catch via `instanceof` to react programmatically (e.g. trigger a
// consolidate-then-retry flow on InsufficientCoverError).

import type { StoredNote } from "./note-store";

/// Thrown by `Wallet.transfer` / `Wallet.withdraw` when the SFRT selector
/// cannot find a 1- or 2-note cover for the requested amount, but the total
/// unspent balance for the asset IS sufficient. Caller should self-spend
/// `consolidate` first (combine into one note), re-sync, then retry.
export class InsufficientCoverError extends Error {
    readonly name = "InsufficientCoverError";
    readonly target: bigint;
    readonly asset: bigint;
    readonly consolidate: StoredNote[];
    readonly consolidateSum: bigint;

    constructor(args: {
        target: bigint;
        asset: bigint;
        consolidate: StoredNote[];
        consolidateSum: bigint;
    }) {
        super(
            `insufficient 2-note cover for ${args.target} (asset ${args.asset}); ` +
                `consolidate two smallest notes first ` +
                `(ids: ${args.consolidate.map((n) => n.id).join(", ")}, ` +
                `sum: ${args.consolidateSum}), then re-run`,
        );
        this.target = args.target;
        this.asset = args.asset;
        this.consolidate = args.consolidate;
        this.consolidateSum = args.consolidateSum;
    }
}

/// Thrown when a required `WalletConfig` field is missing AND no pluggable
/// override was supplied. Includes a hint to point users at the presets
/// (`fastWallet`, `nodeWallet`) that wire common setups in one call.
export class WalletConfigError extends Error {
    readonly name = "WalletConfigError";
    constructor(message: string) {
        super(`${message}. See \`presets\` (fastWallet / nodeWallet) for opinionated defaults.`);
    }
}
