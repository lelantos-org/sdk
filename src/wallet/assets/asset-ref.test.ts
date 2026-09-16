import { describe, expect, it } from "vitest";
import { InvalidArgumentError } from "../../errors/config.js";
import { classifyRef, describeRef, matchRef } from "./asset-ref.js";
import type { AssetInfo } from "./index.js";

const asset = (id: bigint, token: string, symbol?: string): AssetInfo =>
    ({ id, token, scale: 1n, disabled: false, symbol }) as unknown as AssetInfo;

const WETH = asset(1n, "0xAAaaAAaaAAaaAAaaAAaaAAaaAAaaAAaaAAaaAAaa", "WETH");
const USDC = asset(2n, "0xBBbbBBbbBBbbBBbbBBbbBBbbBBbbBBbbBBbbBBbb", "USDC");
const REGISTRY = [WETH, USDC];

describe("classifyRef", () => {
    // Classification is syntactic and independent of registry contents.
    it("reads a bigint and a decimal string as the same id", () => {
        expect(classifyRef(7n)).toEqual({ kind: "id", id: 7n });
        expect(classifyRef("7")).toEqual({ kind: "id", id: 7n });
    });

    it("reads a 0x address as a token, case-insensitively", () => {
        expect(classifyRef(WETH.token)).toEqual({ kind: "token", token: WETH.token.toLowerCase() });
    });

    it("reads anything else as a symbol", () => {
        expect(classifyRef("WETH")).toEqual({ kind: "symbol", symbol: "weth" });
        expect(classifyRef(" weth ")).toEqual({ kind: "symbol", symbol: "weth" });
    });

    /// A malformed address must not fall through to a symbol lookup, whose error
    /// would point at the registry instead of the input.
    it("rejects a 0x value that is not an address", () => {
        expect(() => classifyRef("0xdeadbeef")).toThrow(/not a 20-byte/);
    });

    it("rejects an empty ref", () => {
        expect(() => classifyRef("  ")).toThrow(InvalidArgumentError);
    });
});

describe("matchRef", () => {
    it("finds an asset by id, address or symbol", () => {
        expect(matchRef(REGISTRY, 2n)).toBe(USDC);
        expect(matchRef(REGISTRY, "2")).toBe(USDC);
        expect(matchRef(REGISTRY, USDC.token.toLowerCase())).toBe(USDC);
        expect(matchRef(REGISTRY, "usdc")).toBe(USDC);
    });

    it("returns undefined for an unknown ref rather than guessing", () => {
        expect(matchRef(REGISTRY, 99n)).toBeUndefined();
        expect(matchRef(REGISTRY, "DAI")).toBeUndefined();
    });

    /// Two tokens may share a symbol; picking either could send funds to the wrong one.
    it("refuses an ambiguous symbol instead of picking one", () => {
        const impostor = asset(3n, "0xCCcc000000000000000000000000000000000000", "usdc");
        expect(() => matchRef([...REGISTRY, impostor], "USDC")).toThrow(/ambiguous/);
    });

    /// An address is a valid hex integer and a symbol may be all digits; matching
    /// must not try other kinds when the classified one misses.
    it("does not fall back between kinds", () => {
        // Id 1 exists; no asset has the symbol "1".
        expect(matchRef(REGISTRY, 1n)).toBe(WETH);
        // An unregistered address does not become a symbol lookup.
        expect(matchRef(REGISTRY, "0x0000000000000000000000000000000000000009")).toBeUndefined();
    });
});

describe("describeRef", () => {
    it("names the kind it resolved, for error messages", () => {
        expect(describeRef(1n)).toBe("asset id 1");
        expect(describeRef("WETH")).toBe('symbol "WETH"');
        expect(describeRef(WETH.token)).toContain("token 0x");
    });
});
