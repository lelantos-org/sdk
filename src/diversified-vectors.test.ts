// `tests/vectors/diversified.json` is the parity contract for diversified addresses between this
// SDK and the Rust backend. This suite fails when the committed file is stale; regenerate it with
// `npx tsx scripts/gen-diversified-vectors.ts`.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { Jubjub } from "./crypto/jubjub-wasm/index.js";
import { Poseidon } from "./crypto/poseidon.js";
import {
    buildDiversifiedVectors,
    serializeDiversifiedVectors,
} from "./test-utils/diversified-vectors.js";

const vectorFile = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../tests/vectors/diversified.json",
);

describe("diversified vectors", () => {
    let fresh: ReturnType<typeof buildDiversifiedVectors>;
    beforeAll(async () => {
        fresh = buildDiversifiedVectors(await Jubjub.build(), await Poseidon.build());
    });

    it("the committed file equals a fresh generation", () => {
        expect(readFileSync(vectorFile, "utf8")).toBe(serializeDiversifiedVectors(fresh));
    });

    it("covers a base whose counter-0 candidate does not decode", () => {
        const late = fresh.diversified_base.filter((b) => b.ctr > 0);
        expect(late.length).toBeGreaterThan(0);
        for (const base of late) expect(base.candidates[0]!.decodes).toBe(false);
        expect(fresh.addresses.some((a) => a.g_d_ctr > 0)).toBe(true);
        expect(fresh.addresses.some((a) => a.g_d_ctr === 0)).toBe(true);
    });

    it("tabulates h_i for i in 0..13 and both outcomes of a foreign detection", () => {
        expect(fresh.fmd.h_dec).toHaveLength(14);
        expect(fresh.fmd.clues.every((c) => c.detect_self)).toBe(true);
        expect(fresh.fmd.clues.some((c) => !c.detect_other)).toBe(true);
    });
});
