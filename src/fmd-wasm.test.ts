// Parity: WasmJubjub.fmdTest ≡ circomlibjs fmdTest, on every randomized
// (dk, clue) pair. Auto-skipping when wasm artifact absent.

import { it, expect, beforeAll } from "vitest";
import { Jubjub } from "./crypto/index";
import { wasmDescribe, loadWasmJubjub } from "./crypto/wasm-test-utils";
import {
    fmdTest,
    fmdFlag,
    fmdGenDetectionKey,
    fmdFlagKeyFromDetection,
    type FmdDetectionKey,
    type FmdFlagKey,
} from "./fmd";

wasmDescribe("WasmJubjub fmdTest parity vs circomlibjs", () => {
    let circomJ: Jubjub;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let wasmJ: any;

    beforeAll(async () => {
        circomJ = await Jubjub.build();
        wasmJ = await loadWasmJubjub();
    });

    it("matches circomlibjs on self-detect (always accept)", () => {
        for (let seed = 1; seed <= 30; seed++) {
            const dk: FmdDetectionKey = fmdGenDetectionKey(() => BigInt(seed) || 1n);
            const fk: FmdFlagKey = fmdFlagKeyFromDetection(circomJ, dk);
            const clue = fmdFlag(circomJ, fk, BigInt(seed * 31) || 1n);
            const a = fmdTest(circomJ, dk, clue);
            const b = fmdTest(wasmJ, dk, clue);
            expect(b).toBe(a);
            expect(a).toBe(true);
        }
    });

    it("matches circomlibjs on foreign clue (mostly reject)", () => {
        const me = fmdGenDetectionKey(() => 12345n);
        const eveDk = fmdGenDetectionKey(() => 99999n);
        const eveFk = fmdFlagKeyFromDetection(circomJ, eveDk);
        for (let seed = 1; seed <= 100; seed++) {
            const clue = fmdFlag(circomJ, eveFk, BigInt(seed * 7) || 1n);
            const a = fmdTest(circomJ, me, clue);
            const b = fmdTest(wasmJ, me, clue);
            expect(b).toBe(a);
        }
    });

    it("rejects garbage R", () => {
        const dk = fmdGenDetectionKey(() => 42n);
        const fk = fmdFlagKeyFromDetection(circomJ, dk);
        const clue = fmdFlag(circomJ, fk, 7n);
        clue.R = new Uint8Array(32).fill(0xff);
        expect(fmdTest(wasmJ, dk, clue)).toBe(false);
    });
});
