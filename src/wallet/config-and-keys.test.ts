import { describe, expect, it } from "vitest";
import { BN254_FR } from "../core/field.js";
import { resolveNsk } from "../keys/key-source.js";
import type { WalletConfig } from "./config.js";
import { validateConfig } from "./defaults/validate.js";

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

describe("resolveNsk", () => {
    it("rejects a raw nsk of zero, which makes pk_d the identity", () => {
        // `nsk = 0` gives `pk_d = 0 · Base8 = O`, and every note encrypted to
        // the identity is decryptable by anyone who sees the ephemeral key.
        expect(() => resolveNsk({ type: "nsk", nsk: 0n })).toThrow(/nsk must be/);
    });

    it("rejects an unreduced raw nsk instead of aliasing it to another wallet", () => {
        expect(() => resolveNsk({ type: "nsk", nsk: BN254_FR + 5n })).toThrow(/nsk must be/);
        expect(() => resolveNsk({ type: "nsk", nsk: BN254_FR })).toThrow(/nsk must be/);
    });

    it("accepts a canonical nsk", () => {
        expect(resolveNsk({ type: "nsk", nsk: 5n })).toBe(5n);
        expect(resolveNsk({ type: "nsk", nsk: BN254_FR - 1n })).toBe(BN254_FR - 1n);
    });
});

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
