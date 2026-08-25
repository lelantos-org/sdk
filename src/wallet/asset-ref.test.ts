import { describe, expect, it } from "vitest";
import { InvalidArgumentError } from "../core/errors.js";
import { classifyRef, describeRef, matchRef } from "./asset-ref.js";
import type { AssetInfo } from "./assets.js";

const asset = (id: bigint, token: string, symbol?: string): AssetInfo =>
    ({ id, token, scale: 1n, disabled: false, symbol }) as unknown as AssetInfo;

const WETH = asset(1n, "0xAAaaAAaaAAaaAAaaAAaaAAaaAAaaAAaaAAaaAAaa", "WETH");
const USDC = asset(2n, "0xBBbbBBbbBBbbBBbbBBbbBBbbBBbbBBbbBBbbBBbb", "USDC");
const REGISTRY = [WETH, USDC];

describe("classifyRef", () => {
    // The rules are syntactic so the same ref always means the same thing,
    // whatever happens to be registered.
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

    /// A mistyped address must not silently degrade into a symbol lookup: the
    /// error would then point at the registry rather than at the typo.
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

    /// Two tokens can legitimately share a symbol. Picking either would send
    /// funds to whichever was registered first, so this has to be refused.
    it("refuses an ambiguous symbol instead of picking one", () => {
        const impostor = asset(3n, "0xCCcc000000000000000000000000000000000000", "usdc");
        expect(() => matchRef([...REGISTRY, impostor], "USDC")).toThrow(/ambiguous/);
    });

    /// An address is a valid hex integer and a symbol may be all digits, so a
    /// "try each field" resolver would answer differently per registry. These
    /// pin that it does not.
    it("does not fall back between kinds", () => {
        // The id 1 exists, but as a symbol "1" is not registered.
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
