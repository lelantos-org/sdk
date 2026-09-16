import { describe, expect, it } from "vitest";
import type { WalletConfig } from "../types/config.js";
import { validateConfig } from "./validate.js";

const base = (over: Partial<WalletConfig> = {}): WalletConfig =>
    ({
        chainId: 31337n,
        relayerAddress: `0x${"11".repeat(20)}`,
        chain: {},
        treeDepth: 10,
        fmdUrl: "http://fmd.invalid",
        relayerUrl: "http://relayer.invalid",
        ...over,
    }) as unknown as WalletConfig;

describe("validateConfig treeDepth", () => {
    it("accepts the deployed depth", () => {
        expect(() => validateConfig(base())).not.toThrow();
    });

    it("rejects a fractional depth, which sizes a tree nothing can reconcile", () => {
        expect(() => validateConfig(base({ treeDepth: 10.5 }))).toThrow(/treeDepth/);
    });

    it("rejects an absurd depth", () => {
        // `4 ** treeDepth` is the leaf capacity and drives the chunk ceiling.
        expect(() => validateConfig(base({ treeDepth: 1000 }))).toThrow(/treeDepth/);
    });

    it("still rejects zero and negative", () => {
        expect(() => validateConfig(base({ treeDepth: 0 }))).toThrow(/treeDepth/);
        expect(() => validateConfig(base({ treeDepth: -1 }))).toThrow(/treeDepth/);
    });
});
