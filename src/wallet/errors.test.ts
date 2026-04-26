import { describe, expect, it } from "vitest";
import {
    InsufficientCoverError,
    isWalletError,
    NetworkError,
    WALLET_ERROR_CODES,
    WalletConfigError,
} from "../core/errors.js";

const cover = new InsufficientCoverError({
    target: 10n,
    asset: 1n,
    consolidate: [],
    consolidateSum: 4n,
});

describe("isWalletError", () => {
    it("accepts SDK errors and rejects everything else", () => {
        expect(isWalletError(cover)).toBe(true);
        expect(isWalletError(new WalletConfigError("nope"))).toBe(true);
        expect(isWalletError(new Error("plain"))).toBe(false);
        expect(isWalletError({ code: "INSUFFICIENT_COVER" })).toBe(false);
        expect(isWalletError(undefined)).toBe(false);
    });

    it("filters on a specific code", () => {
        expect(isWalletError(cover, "INSUFFICIENT_COVER")).toBe(true);
        expect(isWalletError(cover, "WALLET_CONFIG")).toBe(false);
    });

    it("ignores unknown codes on Error-shaped objects", () => {
        const impostor = Object.assign(new Error("x"), { code: "ENOENT" });
        expect(isWalletError(impostor)).toBe(false);
    });

    it("narrows to the variant's context fields", () => {
        const err: unknown = cover;
        if (!isWalletError(err, "INSUFFICIENT_COVER")) throw new Error("guard failed");
        // Type-level assertion: these only compile after narrowing.
        expect(err.consolidateSum).toBe(4n);
        expect(err.target).toBe(10n);
    });
});

describe("error codes", () => {
    it("every class reports a code from the published list", () => {
        const errors = [
            cover,
            new WalletConfigError("x"),
            new NetworkError("FMD_TIMEOUT", "http://x", "timed out"),
        ];
        for (const e of errors) expect(WALLET_ERROR_CODES).toContain(e.code);
    });

    it("keeps the URL and status on network failures", () => {
        const e = new NetworkError("RELAYER_FAILED", "http://r", "boom", { status: 502 });
        expect(e.url).toBe("http://r");
        expect(e.status).toBe(502);
        expect(e.message).toContain("http://r");
    });
});
