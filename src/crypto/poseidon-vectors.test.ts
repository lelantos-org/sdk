// Cross-implementation Poseidon parity, SDK side.
//
// The same `tests/vectors/poseidon.json` is asserted by the Rust backend in
// `backend/crates/crypto/tests/poseidon_vectors.rs`. Both files must stay
// byte-identical; `scripts/gen-poseidon-vectors.ts` writes both copies.
//
// `anchors` are the digests circomlibjs publishes, tying the SDK to circomlib itself rather than
// to whichever backend (JS or vendored wasm) is in use.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { Poseidon } from "./poseidon.js";

interface Vector {
    label: string;
    inputs: string[];
    digest: string;
}

const vectorFile = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../tests/vectors/poseidon.json",
);
const parsed = JSON.parse(readFileSync(vectorFile, "utf8")) as {
    anchors: Vector[];
    vectors: Vector[];
};

/**
 * Highest arity the SDK's table serves. See `poseidon.ts`.
 *
 * The shared vector file covers the Rust crate's wider range, so rows above
 * this width are skipped here and asserted by `backend/crates/crypto`.
 */
const MAX_ARITY = 6;
const served = (v: Vector) => v.inputs.length <= MAX_ARITY;

const anchors = parsed.anchors.filter(served);
const vectors = parsed.vectors.filter(served);
const skipped = parsed.anchors.length + parsed.vectors.length - anchors.length - vectors.length;

describe("poseidon vectors", () => {
    let P: Poseidon;
    beforeAll(async () => {
        P = await Poseidon.build();
    });

    it("has vectors to check", () => {
        expect(anchors.length).toBeGreaterThan(0);
        expect(vectors.length).toBeGreaterThan(0);
    });

    it("skips only widths the table does not serve", () => {
        // Guards the filter so a change to `MAX_ARITY` or the file cannot silently reduce coverage.
        expect(skipped).toBe(2);
        for (const v of [...anchors, ...vectors]) {
            expect(v.inputs.length).toBeLessThanOrEqual(MAX_ARITY);
        }
    });

    it("rejects an arity the table does not serve", () => {
        expect(() => P.hash(Array.from({ length: MAX_ARITY + 1 }, (_, i) => BigInt(i)))).toThrow(
            /not supported/,
        );
    });

    it.each(
        anchors.map((a) => [a.label, a] as const),
    )("anchor: %s matches circomlib", (_label, v) => {
        expect(P.hash(v.inputs.map(BigInt)).toString()).toBe(v.digest);
    });

    it.each(vectors.map((v) => [v.label, v] as const))("%s", (_label, v) => {
        expect(P.hash(v.inputs.map(BigInt)).toString()).toBe(v.digest);
    });
});
