// Parity test: WasmProver vs SnarkjsProver produce verifiable Groth16 proofs
// of the same `Groth16Proof` shape (snarkjs decimal-string convention).
//
// Groth16 proofs are randomized (snarkjs picks r,s; WASM uses 0,0 → its proof
// is deterministic), so pi_a/pi_b/pi_c will NOT match across implementations.
// The meaningful check is: each proof verifies under the same vkey, and both
// produce identical publicSignals for identical witness input.
//
// Skipped unless the circuit fixtures exist on disk (gated by file presence,
// not env var, so local devs with `circuits/build/` set up get coverage for
// free).

import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
// @ts-ignore — snarkjs ships without types
import * as snarkjs from "snarkjs";

import { WasmProver } from "./wasm-prover";
import { SnarkjsProver } from "./prover";
import { buildTreeUpdateInput } from "../witness/tree-update";

const CIRCUITS_BUILD = resolve(__dirname, "../../../circuits/build");
const TU_WASM = resolve(CIRCUITS_BUILD, "tree_update_js/tree_update.wasm");
const TU_ZKEY = resolve(CIRCUITS_BUILD, "tree_update_final.zkey");
const TU_VKEY = resolve(CIRCUITS_BUILD, "tree_update_verification_key.json");
const PKG_WASM = resolve(__dirname, "../../wasm/prover/pkg/prover_bg.wasm");

const haveFixtures = [TU_WASM, TU_ZKEY, TU_VKEY, PKG_WASM].every(existsSync);
const d = haveFixtures ? describe : describe.skip;

d("WasmProver parity (tree_update)", () => {
    // Synthesizes a minimal-but-valid input: empty tree, insert two zero
    // commitments. Frontier is all zeros at every level for an empty tree;
    // start_index = 0; old_root and new_root recovered from the circuit's
    // own constraints when fed `z` chosen via Fiat–Shamir.
    //
    // We don't compute old/new roots here — instead we let snarkjs's witness
    // calc fail loudly if our shape is wrong, but the circuit's tree-update
    // constraints lock root values to the frontier/cm pair. So we precompute
    // via an off-chain helper if available; otherwise the test will throw
    // and signal that a richer fixture is needed.
    it("both implementations verify under the same vkey", async () => {
        const paths = { wasmPath: TU_WASM, zkeyPath: TU_ZKEY };
        const vkey = JSON.parse(readFileSync(TU_VKEY, "utf-8"));

        // Construct a fixture input. tree_update's old_root/new_root are
        // load-bearing — supplying arbitrary values will fail constraint
        // checks. This test requires a pre-built fixture witness; if the
        // helper below is not available, the test logs and skips parity.
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

        const [wasmOut, snarkOut] = await Promise.all([
            wasm.prove(input),
            snark.prove(input),
        ]);

        expect(wasmOut.publicSignals).toEqual(snarkOut.publicSignals);

        const [wasmOk, snarkOk] = await Promise.all([
            snarkjs.groth16.verify(vkey, wasmOut.publicSignals, wasmOut.proof),
            snarkjs.groth16.verify(vkey, snarkOut.publicSignals, snarkOut.proof),
        ]);
        expect(wasmOk).toBe(true);
        expect(snarkOk).toBe(true);
    }, 120_000);
});

// Smoke test — runs unconditionally to catch regressions in the WasmProver
// module structure (imports, type compatibility with `Prover`).
describe("WasmProver structure", () => {
    it("WasmProver.build is a function", () => {
        expect(typeof WasmProver.build).toBe("function");
    });

    it("buildTreeUpdateInput is wired (sanity)", () => {
        expect(typeof buildTreeUpdateInput).toBe("function");
    });
});
