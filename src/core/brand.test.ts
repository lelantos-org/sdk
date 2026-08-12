import { describe, expect, it } from "vitest";
import {
    assetId,
    circuitAmount,
    evmAddress,
    hex32,
    shieldedAddress,
    tokenAmount,
} from "./brand.js";
import { isWalletError } from "./errors.js";

const ADDR = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const WORD = `0x${"ab".repeat(32)}`;

describe("evmAddress", () => {
    it("accepts a 20-byte 0x address in either case", () => {
        expect(evmAddress(ADDR)).toBe(ADDR);
        expect(evmAddress(ADDR.toLowerCase())).toBe(ADDR.toLowerCase());
    });

    it("rejects the near-misses that a bare `string` would let through", () => {
        expect(() => evmAddress(ADDR.slice(0, -1))).toThrow(/EVM address/);
        expect(() => evmAddress(`${ADDR}00`)).toThrow(/EVM address/);
        expect(() => evmAddress(ADDR.slice(2))).toThrow(/EVM address/);
        expect(() => evmAddress(WORD)).toThrow(/EVM address/);
        expect(() => evmAddress("sswap1qqqq")).toThrow(/EVM address/);
    });
});

describe("hex32", () => {
    it("accepts a 32-byte word", () => {
        expect(hex32(WORD)).toBe(WORD);
    });

    it("rejects a 20-byte address and any other width", () => {
        expect(() => hex32(ADDR)).toThrow(/32-byte/);
        expect(() => hex32("0x")).toThrow(/32-byte/);
        expect(() => hex32(`0x${"ab".repeat(31)}`)).toThrow(/32-byte/);
    });
});

describe("shieldedAddress", () => {
    it("accepts a bech32m string under the `sswap` HRP", () => {
        const a = "sswap1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq";
        expect(shieldedAddress(a)).toBe(a);
    });

    it("rejects an EVM address, a bare HRP, and out-of-charset input", () => {
        expect(() => shieldedAddress(ADDR)).toThrow(/shielded address/);
        expect(() => shieldedAddress("sswap1")).toThrow(/shielded address/);
        // `b`, `i` and `o` are not in the bech32 charset.
        expect(() => shieldedAddress("sswap1bio")).toThrow(/shielded address/);
    });
});

describe("assetId", () => {
    it("accepts anything inside uint64", () => {
        expect(assetId(0n)).toBe(0n);
        expect(assetId(1)).toBe(1n);
        expect(assetId((1n << 64n) - 1n)).toBe((1n << 64n) - 1n);
    });

    it("rejects negatives and anything past uint64", () => {
        expect(() => assetId(-1n)).toThrow(/uint64/);
        expect(() => assetId(1n << 64n)).toThrow(/uint64/);
    });
});

describe("amount constructors", () => {
    it("accept zero and positive values", () => {
        expect(circuitAmount(0n)).toBe(0n);
        expect(tokenAmount(10n ** 18n)).toBe(10n ** 18n);
    });

    it("reject negatives", () => {
        expect(() => circuitAmount(-1n)).toThrow(/negative/);
        expect(() => tokenAmount(-1n)).toThrow(/negative/);
    });
});

describe("failures", () => {
    it("are typed INVALID_ARGUMENT so a caller can branch on them", () => {
        let err: unknown;
        try {
            evmAddress("nope");
        } catch (e) {
            err = e;
        }
        expect(isWalletError(err, "INVALID_ARGUMENT")).toBe(true);
    });
});
