import { describe, expect, it } from "vitest";
import { WalletConfigError } from "../../core/errors.js";
import { validateWatchConfig, type WatchWalletConfig } from "./config.js";

const base: WatchWalletConfig = { chainId: 31337n, fmdUrl: "http://fmd.invalid" };

describe("validateWatchConfig", () => {
    it("accepts the minimum", () => {
        expect(() => validateWatchConfig(base)).not.toThrow();
    });

    it("accepts a note source in place of a url", () => {
        expect(() =>
            validateWatchConfig({
                chainId: 1n,
                noteSource: {
                    listNotes: async () => ({ inputs: [], nextAfter: 0, resumeAfter: 0 }),
                },
            }),
        ).not.toThrow();
    });

    it("collects every problem at once", () => {
        try {
            validateWatchConfig({} as WatchWalletConfig);
            expect.unreachable("should have thrown");
        } catch (err) {
            expect(err).toBeInstanceOf(WalletConfigError);
            expect((err as WalletConfigError).missing).toHaveLength(2);
        }
    });

    // Releases the account owner's detection secret, so it requires opt-in.
    it("refuses a `matches` subscription unless it is asked for explicitly", () => {
        const cfg = { ...base, syncStrategy: { kind: "matches", token: "t" } as const };
        expect(() => validateWatchConfig(cfg)).toThrow(WalletConfigError);
        expect(() => validateWatchConfig({ ...cfg, allowDetectionKeyRelease: true })).not.toThrow();
    });
});
