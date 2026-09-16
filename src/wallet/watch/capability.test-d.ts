// The capability boundary, asserted at the type level.
//
// Each `@ts-expect-error` is the assertion: a spend method on `ReadOnlyWalletApi`, or a raw key on
// either wallet object, makes the directive unused and fails the type check. The functions are
// never called.

import type { ReadOnlyWalletApi, WalletApi } from "../api.js";

function _noSpendSurface(w: ReadOnlyWalletApi) {
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

function _noRawKeysOnTheSpendingWallet(w: WalletApi) {
    // @ts-expect-error — the public keys are bech32m strings; the raw key is `walletInternals`'s.
    w.keys.nsk;
    // @ts-expect-error — nor the incoming viewing scalar.
    w.keys.ivk;
    // @ts-expect-error — plumbing is not on the object either.
    w.noteStore;
    const tier: "spending" = w.keys.tier;
    return tier;
}

function _readOnlyIsTheCommonSurface(watch: ReadOnlyWalletApi, full: WalletApi) {
    const a: ReadOnlyWalletApi = watch;
    const b: ReadOnlyWalletApi = full;
    // @ts-expect-error — and a read-only wallet is not a spending one.
    const c: WalletApi = watch;
    return [a, b, c];
}
