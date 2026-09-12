import { describe, expect, it } from "vitest";
import type { ChainAdapter, ChainReader } from "./port.js";
import {
    supportsAllowanceBatch,
    supportsAllowanceTransfer,
    supportsNativeEth,
    supportsSigning,
} from "./port.js";

// The guards are what a caller asks before it commits to a flow, so their
// answers are load-bearing: a false positive reaches `payerAddress` on a layer
// that has none, and a false negative hides the deposit tab from a wallet that
// could have used it.

const reader = (extra: Partial<ChainAdapter> = {}): ChainReader =>
    ({
        chainId: async () => 1n,
        maspAddress: async () => "0x2" as never,
        fetchAsset: async () => ({}) as never,
        ...extra,
    }) as ChainReader;

const payerAddress: ChainAdapter["payerAddress"] = async () => "0x1" as never;
const signPermit2: ChainAdapter["signPermit2"] = async () => ({}) as never;
const SIGNING: Partial<ChainAdapter> = { payerAddress, signPermit2 };

const ALLOWANCE: Partial<ChainAdapter> = {
    ...SIGNING,
    submitDepositAuthorized: async () => ({}) as never,
    permit2Allowance: async () => ({}) as never,
    permit2PermitAllowance: async () => ({}) as never,
    signPermit2Allowance: async () => ({}) as never,
};

describe("supportsSigning", () => {
    it("rejects a read-only layer", () => {
        expect(supportsSigning(reader())).toBe(false);
    });

    it("accepts one carrying both signing members", () => {
        expect(supportsSigning(reader(SIGNING))).toBe(true);
    });

    it("rejects a layer with only half the signing surface", () => {
        // Either alone is useless: a deposit needs the payer named *and* the
        // Permit2 witness signed, and a partial adapter would fail mid-flow
        // with value already committed to a strategy.
        expect(supportsSigning(reader({ payerAddress }))).toBe(false);
        expect(supportsSigning(reader({ signPermit2 }))).toBe(false);
    });
});

describe("the deposit-path guards imply signing", () => {
    it("rejects a reader that happens to carry the deposit members", () => {
        // Without the `supportsSigning` conjunct these would pass on a layer
        // with no `payerAddress`, and every one of them narrows to a type that
        // promises it.
        const { payerAddress: _p, signPermit2: _s, ...unsigned } = ALLOWANCE;
        const half = reader(unsigned);
        expect(supportsAllowanceTransfer(half)).toBe(false);

        const native = reader({
            submitDepositNative: (async () => ({})) as never,
            nativeAdapterAddress: () => "0xada" as never,
        });
        expect(supportsNativeEth(native)).toBe(false);
    });

    it("accepts a full AllowanceTransfer adapter", () => {
        const c = reader(ALLOWANCE);
        expect(supportsAllowanceTransfer(c)).toBe(true);
        // Strictly narrower: single-token setup does not imply the batch.
        expect(supportsAllowanceBatch(c)).toBe(false);

        const batch = reader({
            ...ALLOWANCE,
            signPermit2AllowanceBatch: (async () => ({})) as never,
            permit2PermitAllowanceBatch: (async () => ({})) as never,
        });
        expect(supportsAllowanceBatch(batch)).toBe(true);
    });

    it("requires the native adapter address, not just the call", () => {
        // The address is what the deposit builder names as `payer`, so an
        // adapter that can encode the call but not name the contract is not
        // usable.
        const noAddr = reader({
            ...SIGNING,
            submitDepositNative: (async () => ({})) as never,
            nativeAdapterAddress: () => undefined,
        });
        expect(supportsNativeEth(noAddr)).toBe(false);

        const full = reader({
            ...SIGNING,
            submitDepositNative: (async () => ({})) as never,
            nativeAdapterAddress: () => "0xada" as never,
        });
        expect(supportsNativeEth(full)).toBe(true);
    });
});
