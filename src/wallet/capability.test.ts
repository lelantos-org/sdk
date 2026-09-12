// The signing boundary, asserted at the type level.
//
// Each `@ts-expect-error` is the assertion: a signing member reachable from a
// `ChainReader`, or a `WalletApi.chain` that already has one, makes the
// directive unused and fails `tsc -p tsconfig.test.json`. The functions are
// never called.
//
// The counterpart of `watch/capability.test.ts`. That one draws the line
// between viewing and spending; this one draws it between spending out of the
// pool — which the circuit authorises and the relayer broadcasts — and
// shielding into it, which needs an EOA that holds the tokens and the gas.

import { describe, expect, it } from "vitest";
import type { ChainAdapter, ChainReader } from "../chain/port.js";
import type { WalletApi } from "./api.js";
import { supportsDeposit } from "./capability.js";

function _readerHasNoSigningSurface(c: ChainReader) {
    // @ts-expect-error — a reader names no payer; a deposit comes from an EOA.
    c.payerAddress;
    // @ts-expect-error — nor can it sign a Permit2 witness.
    c.signPermit2;
    // @ts-expect-error — nor submit the deposit that witness authorises.
    c.submitDeposit;
    // @ts-expect-error — nor the native-coin one.
    c.submitDepositNative;
    // @ts-expect-error — nor the AllowanceTransfer one.
    c.submitDepositAuthorized;
    // @ts-expect-error — nor sign an allowance window.
    c.signPermit2Allowance;
    // @ts-expect-error — nor approve an ERC-20.
    c.tokenApprove;
    // @ts-expect-error — nor wrap the native coin.
    c.wrapNative;
    // @ts-expect-error — nor cancel an escrow it could not have opened.
    c.cancelDeposit;

    // The reads a spend does need stay available. Listed rather than implied:
    // this half is what makes a passkey wallet usable at all, and a refactor
    // that quietly moved one of these into the signing half would otherwise
    // only surface as a broken transfer.
    c.chainId;
    c.maspAddress;
    c.fetchAsset;
    c.blockNumber;
    c.isKnownRoot;
    c.nativeAdapterAddress;
    c.waitTxReceipt;
    c.permit2Allowance;
    c.tokenBalanceOf;
    c.nativeBalance;
}

function _walletChainIsAReaderUntilNarrowed(w: WalletApi) {
    // @ts-expect-error — `WalletApi.chain` is a reader; deposits need a guard.
    w.chain.payerAddress;
    // @ts-expect-error — same for the witness signature.
    w.chain.signPermit2;
    // Reads need no narrowing.
    w.chain.fetchAsset;
    if (supportsDeposit(w)) {
        // Narrowed: the signing half is typed here and nowhere else.
        w.chain.payerAddress;
        w.chain.signPermit2;
        w.chain.submitDeposit;
    }
}

function _adapterWidensOneWay(a: ChainAdapter, r: ChainReader) {
    // Every adapter is a reader.
    const widened: ChainReader = a;
    // @ts-expect-error — and no reader is an adapter without a runtime check.
    const narrowed: ChainAdapter = r;
    return [widened, narrowed];
}

describe("capability boundary", () => {
    it("is enforced by the directives above", () => {
        // The assertions are the `@ts-expect-error` comments, checked by
        // `tsc -p tsconfig.test.json`. This keeps vitest collecting the file.
        expect(typeof supportsDeposit).toBe("function");
    });
});
