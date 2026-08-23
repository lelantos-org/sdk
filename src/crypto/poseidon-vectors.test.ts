// Cross-implementation Poseidon parity, SDK side.
//
// The same `tests/vectors/poseidon.json` is asserted by the Rust backend in
// `backend/crates/fmd-crypto/tests/poseidon_vectors.rs`. Both files must stay
// byte-identical; `scripts/gen-poseidon-vectors.ts` writes both copies.
//
// `anchors` are the digests circomlibjs publishes, so this ties the SDK to
// circomlib itself rather than to whichever implementation happens to be
// wired in — which is the property that has to survive swapping the JS
// backend for the vendored wasm one.

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
const { anchors, vectors } = JSON.parse(readFileSync(vectorFile, "utf8")) as {
    anchors: Vector[];
    vectors: Vector[];
};

describe("poseidon vectors", () => {
    let P: Poseidon;
    beforeAll(async () => {
        P = await Poseidon.build();
    });

    it("has vectors to check", () => {
        expect(anchors.length).toBeGreaterThan(0);
        expect(vectors.length).toBeGreaterThan(0);
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
