// Parity: WasmJubjub must match circomlibjs Jubjub byte-for-byte on every
// op that touches wire bytes. Auto-skips when the WASM artifact has not
// been built (CI runs `just build` in `wasm/` before tests).

import { it, expect, beforeAll } from "vitest";
import { Jubjub, BABYJUB_SUBGROUP_ORDER, type Point } from "./index";
import { wasmDescribe, loadWasmJubjub } from "./wasm-test-utils";

wasmDescribe("WasmJubjub parity vs circomlibjs", () => {
    let J: Jubjub;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let W: any;

    beforeAll(async () => {
        J = await Jubjub.build();
        W = await loadWasmJubjub();
    });

    it("base8 identical", () => {
        expect(W.base8).toEqual(J.base8);
    });

    it("order identical", () => {
        expect(W.order).toEqual(J.order);
    });

    it("mulPointEscalar(base8, k) matches across many scalars", () => {
        for (let i = 1; i < 20; i++) {
            const k = (BigInt(i) * 0x9e3779b97f4a7c15n) % BABYJUB_SUBGROUP_ORDER || 1n;
            const a = J.mulPointEscalar(J.base8, k);
            const b = W.mulPointEscalar(W.base8, k);
            expect(b).toEqual(a);
        }
    });

    it("packPoint / unpackPoint round-trip and match circomlibjs bytes", () => {
        for (let i = 1; i < 10; i++) {
            const k = (BigInt(i) * 0x123456789n) % BABYJUB_SUBGROUP_ORDER || 1n;
            const p: Point = J.mulPointEscalar(J.base8, k);
            const aBytes = J.packPoint(p);
            const bBytes = W.packPoint(p);
            expect(bBytes).toEqual(aBytes);

            const aBack = J.unpackPoint(aBytes);
            const bBack = W.unpackPoint(bBytes);
            expect(bBack).toEqual(aBack);
        }
    });

    it("addPoint matches", () => {
        const p1 = J.mulPointEscalar(J.base8, 7n);
        const p2 = J.mulPointEscalar(J.base8, 13n);
        expect(W.addPoint(p1, p2)).toEqual(J.addPoint(p1, p2));
    });

    it("inSubgroup matches", () => {
        const p = J.mulPointEscalar(J.base8, 42n);
        expect(W.inSubgroup(p)).toBe(J.inSubgroup(p));
    });
});
