// The signing boundary, asserted at the type level.
//
// Each `@ts-expect-error` is an assertion: if a signing member becomes reachable from a
// `ChainReader` or an un-narrowed `WalletApi.chain`, the directive is unused and the type check
// fails. The functions are never called.
//
// Counterpart of `watch/capability.test-d.ts`, which separates viewing from spending. This file
// separates spending from the pool (authorised by the circuit, broadcast by the relayer) from
// shielding into it, which needs an EOA holding the tokens and gas.

import type { ChainAdapter, ChainReader } from "../../chain/port.js";
import type { WalletApi } from "../api.js";
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

    // Reads required by a spend remain available. Listed explicitly so that moving one into the
    // signing surface fails type-checking instead of breaking transfers for non-signing wallets.
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
