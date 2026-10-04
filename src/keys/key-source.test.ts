import { describe, expect, it } from "vitest";
import { BN254_FR } from "../core/field.js";
import { type KeySource, loadNsk } from "./key-source.js";
import { resolveNsk } from "./mnemonic.js";

describe("resolveNsk", () => {
    it("rejects a raw nsk of zero, which makes pk_d the identity", () => {
        // `nsk = 0` gives `pk_d = 0 · Base8 = O`; a note encrypted to the
        // identity is decryptable by anyone who sees the ephemeral key.
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

describe("loadNsk", () => {
    const sources: KeySource[] = [
        {
            type: "mnemonic",
            mnemonic: "test test test test test test test test test test test junk",
        },
        {
            type: "mnemonic",
            mnemonic: "test test test test test test test test test test test junk",
            account: 3,
            passphrase: "p",
        },
        { type: "privateKey", hex: `0x${"11".repeat(32)}` },
        { type: "passkeyPrf", prf: new Uint8Array(32).fill(7) },
        { type: "nsk", nsk: 5n },
    ];

    it.each(
        sources.map((s) => [s.type, s] as const),
    )("agrees with resolveNsk for %s", async (_t, s) => {
        expect(await loadNsk(s)).toBe(resolveNsk(s));
    });

    it("rejects where resolveNsk throws", async () => {
        await expect(loadNsk({ type: "nsk", nsk: 0n })).rejects.toThrow(/nsk must be/);
        await expect(loadNsk({ type: "mnemonic", mnemonic: "not a mnemonic" })).rejects.toThrow();
    });
});
