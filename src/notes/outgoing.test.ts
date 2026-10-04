import { describe, expect, it } from "vitest";
import { BABYJUB_SUBGROUP_ORDER } from "../core/field.js";
import { deriveOutgoingKey, deriveOutputEsk } from "./outgoing.js";

// An output's ephemeral is recomputed from the seed and what the pool published. Any drift in the
// derivation strands every proof of a past payment, and any collision reuses a cipher key.

describe("deriveOutgoingKey", () => {
    it("is a fixed function of nsk", () => {
        expect(deriveOutgoingKey(7n)).toEqual(deriveOutgoingKey(7n));
        expect(deriveOutgoingKey(7n)).toHaveLength(32);
        expect(deriveOutgoingKey(7n)).not.toEqual(deriveOutgoingKey(8n));
    });

    it("matches its recorded vector", () => {
        const hex = Array.from(deriveOutgoingKey(1n), (b) => b.toString(16).padStart(2, "0"));
        expect(hex.join("")).toMatchInlineSnapshot(
            `"063f941000a6c9bdf75ba64a578f146bcd1d7ba4d577b5ca4e31e22c9a827f5a"`,
        );
    });
});

describe("deriveOutputEsk", () => {
    const ock = deriveOutgoingKey(7n);

    it("is deterministic and a valid non-zero subgroup scalar", () => {
        const esk = deriveOutputEsk(ock, 1n, 99n);
        expect(deriveOutputEsk(ock, 1n, 99n)).toBe(esk);
        expect(esk).toBeGreaterThan(0n);
        expect(esk).toBeLessThan(BABYJUB_SUBGROUP_ORDER);
    });

    it("matches its recorded vector", () => {
        expect(deriveOutputEsk(ock, 1n, 99n).toString()).toMatchInlineSnapshot(
            `"2306612580130578517305438206154513715338078729156018558219470172790966700478"`,
        );
    });

    // Each input separates outputs whose plaintexts differ; see the file header.
    it("differs with the key, the chain and the commitment", () => {
        const base = deriveOutputEsk(ock, 1n, 99n);
        const variants = [
            deriveOutputEsk(deriveOutgoingKey(8n), 1n, 99n),
            deriveOutputEsk(ock, 2n, 99n),
            deriveOutputEsk(ock, 1n, 100n),
        ];
        expect(new Set([base, ...variants]).size).toBe(variants.length + 1);
    });
});
