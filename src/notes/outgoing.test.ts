import { describe, expect, it } from "vitest";
import { deriveOutgoingKey } from "./outgoing.js";

// Every output secret is recomputed from this key. Any drift in the derivation strands every proof
// of a past payment.

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
