// The capability boundary, asserted at the type level.
//
// Each `@ts-expect-error` is the assertion: a spend method on `WatchWallet`, or
// `nsk` in its key type, makes the directive unused and fails
// `tsc -p tsconfig.test.json`. The functions are never called.

import { describe, expect, it } from "vitest";
import type { SpendingKey } from "../../keys/keys.js";
import type { ReadOnlyWalletApi, WalletApi } from "../api.js";
import type { WatchWallet } from "./watch-wallet.js";

function _noSpendSurface(w: WatchWallet) {
    // @ts-expect-error — a watch wallet cannot transfer.
    w.transfer;
    // @ts-expect-error — nor withdraw.
    w.withdraw;
    // @ts-expect-error — nor swap.
    w.swap;
    // @ts-expect-error — nor deposit.
    w.deposit;
    // @ts-expect-error — nor mark a note spent by hand.
    w.markSpent;
    // @ts-expect-error — and it holds no prover.
    w.prover;
    // @ts-expect-error — nor a submitter.
    w.submitter;
    // @ts-expect-error — nor a Merkle tree to witness a spend against.
    w.treeStore;
    // @ts-expect-error — `nsk` is the spend key and never reaches here.
    w.keys.nsk;
}

function _readOnlyIsTheCommonSurface(watch: WatchWallet, full: WalletApi) {
    const a: ReadOnlyWalletApi = watch;
    const b: ReadOnlyWalletApi = full;
    // A `SpendingKey` satisfies the read-only key slot; the reverse does not.
    const keys: ReadOnlyWalletApi["keys"] = {} as SpendingKey;
    // @ts-expect-error — and a viewing key is not a spending key.
    const spend: SpendingKey = keys;
    return [a, b, spend];
}

describe("watch wallet capability boundary", () => {
    it("is enforced by the compiler, not at runtime", () => {
        // The assertions are in the functions above. This keeps the file a test
        // rather than a module the runner would skip.
        expect(typeof _noSpendSurface).toBe("function");
    });
});
