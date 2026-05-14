// Parity: WasmProver vs SnarkjsProver. Groth16 is randomized so pi_a/pi_b/pi_c
// differ across implementations; we check both proofs verify under the same
// vkey and produce identical publicSignals. Skipped unless fixtures exist.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
// @ts-expect-error — snarkjs ships without types
import * as snarkjs from "snarkjs";
import { describe, expect, it } from "vitest";
import { SnarkjsProver } from "./prover.js";
import { WasmProver } from "./wasm-prover.js";

const CIRCUITS_BUILD = resolve(__dirname, "../../../circuits/build");
const TU_WASM = resolve(CIRCUITS_BUILD, "tree_update_js/tree_update.wasm");
const TU_ZKEY = resolve(CIRCUITS_BUILD, "tree_update_final.zkey");
const TU_VKEY = resolve(CIRCUITS_BUILD, "tree_update_verification_key.json");
const PKG_WASM = resolve(__dirname, "../../wasm/prover/pkg/prover_bg.wasm");

const haveFixtures = [TU_WASM, TU_ZKEY, TU_VKEY, PKG_WASM].every(existsSync);
const d = haveFixtures ? describe : describe.skip;

d("WasmProver parity (tree_update)", () => {
    it("both implementations verify under the same vkey", async () => {
        const paths = { wasmPath: TU_WASM, zkeyPath: TU_ZKEY };
        const vkey = JSON.parse(readFileSync(TU_VKEY, "utf-8"));

        // tree_update's old_root/new_root are load-bearing; needs prebuilt fixture.
        const fixturePath = resolve(__dirname, "../../tests/fixtures/tree_update.input.json");
        if (!existsSync(fixturePath)) {
            console.warn(
                `[wasm-prover.test] missing ${fixturePath} — skipping parity. ` +
                    `Generate via scripts/gen-tree-update-fixture.ts.`,
            );
            return;
        }
        const input = JSON.parse(readFileSync(fixturePath, "utf-8")) as Record<string, unknown>;

        const wasm = await WasmProver.build(paths);
        const snark = new SnarkjsProver(paths);

        const [wasmOut, snarkOut] = await Promise.all([wasm.prove(input), snark.prove(input)]);

        expect(wasmOut.publicSignals).toEqual(snarkOut.publicSignals);

        const [wasmOk, snarkOk] = await Promise.all([
            snarkjs.groth16.verify(vkey, wasmOut.publicSignals, wasmOut.proof),
            snarkjs.groth16.verify(vkey, snarkOut.publicSignals, snarkOut.proof),
        ]);
        expect(wasmOk).toBe(true);
        expect(snarkOk).toBe(true);
    }, 120_000);
});

describe("WasmProver structure", () => {
    it("WasmProver.build is a function", () => {
        expect(typeof WasmProver.build).toBe("function");
    });
});
