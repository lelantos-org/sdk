// Parity: LocalScanner output identical to direct `scanNotes`.
// Worker pool is browser-only — covered by smoke test in CI/browser env,
// not vitest.

import { describe, it, expect, beforeAll } from "vitest";
import { Poseidon, Jubjub, BABYJUB_SUBGROUP_ORDER, type Field } from "../crypto/index";
import { buildSpendingKey } from "../keys";
import { encryptNote } from "../note-encrypt";
import { encodeNotePayload, withClueBitsPrefix, clueBitsToPrefix } from "../note-codec";
import { fmdFlag, fmdGenDetectionKey, fmdFlagKeyFromDetection } from "../fmd";
import { scanNotes, type ScanInput } from "../sync";
import { LocalScanner } from "./scanner-local";
import { WorkerPoolScanner, type WorkerLike } from "./scanner-worker-pool";
import { scanNotes as workerScanNotes } from "../sync";
import {
    decodeInput,
    decodeDetection,
    encodeHit,
    type InitReq,
    type ScanReq,
    type ScanRes,
    type InitRes,
} from "./scanner-worker-protocol";

describe("LocalScanner", () => {
    let P: Poseidon;
    let J: Jubjub;
    beforeAll(async () => {
        P = await Poseidon.build();
        J = await Jubjub.build();
    });

    it("matches scanNotes output for a mixed batch", async () => {
        const me = buildSpendingKey(P, J, 1234n);
        const eve = buildSpendingKey(P, J, 9999n);
        const dk = fmdGenDetectionKey(() => 7n);
        const fk = fmdFlagKeyFromDetection(J, dk);
        const eveDk = fmdGenDetectionKey(() => 13n);
        const eveFk = fmdFlagKeyFromDetection(J, eveDk);

        const inputs: ScanInput[] = [];
        const mkInput = (
            recipient: typeof me,
            flagKey: typeof fk,
            esk: Field,
            r: Field,
            value: bigint,
            leafIndex: number,
        ): void => {
            const enc = encryptNote({
                J,
                recipientPkD: recipient.pk_d,
                esk,
                plaintext: encodeNotePayload({ asset: 1n, value, rho: 3n, rcm: 4n }),
            });
            const clue = fmdFlag(J, flagKey, r);
            const wire = withClueBitsPrefix(
                clueBitsToPrefix(clue.bits, clue.gamma),
                enc.ciphertext,
            );
            inputs.push({
                ciphertext: wire,
                epk: enc.epk,
                cm: BigInt(leafIndex),
                leafIndex,
                clue,
            });
        };

        mkInput(me, fk, 11n, 22n, 100n, 0);
        mkInput(eve, eveFk, 33n, 44n, 200n, 1);
        mkInput(me, fk, 55n % BABYJUB_SUBGROUP_ORDER, 66n, 300n, 2);
        mkInput(eve, eveFk, 77n, 88n, 400n, 3);

        const direct = scanNotes(J, me.ivk, inputs, dk);
        const scanner = new LocalScanner(J);
        const viaScanner = await scanner.scan(me.ivk, inputs, dk);

        expect(viaScanner).toEqual(direct);
        expect(viaScanner.map((h) => h.leafIndex)).toEqual([0, 2]);
        expect(viaScanner.map((h) => h.value)).toEqual([100n, 300n]);
    });

    // In-process fake of `WorkerLike`: runs the scanner-worker logic
    // synchronously on the same thread. Validates the postMessage protocol
    // wiring without spinning real Web Workers (which vitest/Node lack).
    function makeFakeWorker(J: Jubjub): WorkerLike {
        let onmessage: ((ev: { data: unknown }) => void) | null = null;
        const w: WorkerLike = {
            postMessage(msg: unknown): void {
                queueMicrotask(() => {
                    const m = msg as InitReq | ScanReq;
                    if (m.type === "init") {
                        const res: InitRes = { type: "init-res", id: m.id };
                        onmessage?.({ data: res });
                        return;
                    }
                    if (m.type === "scan") {
                        const inputs = m.inputs.map(decodeInput);
                        const dk = decodeDetection(m.detectionKey);
                        const hits = workerScanNotes(J, BigInt(m.ivk), inputs, dk);
                        const res: ScanRes = {
                            type: "scan-res",
                            id: m.id,
                            hits: hits.map(encodeHit),
                        };
                        onmessage?.({ data: res });
                    }
                });
            },
            terminate(): void {
                onmessage = null;
            },
            get onmessage() {
                return onmessage;
            },
            set onmessage(fn) {
                onmessage = fn;
            },
        };
        return w;
    }

    it("WorkerPoolScanner produces same hits as LocalScanner (fake workers)", async () => {
        const me = buildSpendingKey(P, J, 1234n);
        const eve = buildSpendingKey(P, J, 9999n);
        const dk = fmdGenDetectionKey(() => 7n);
        const fk = fmdFlagKeyFromDetection(J, dk);
        const eveDk = fmdGenDetectionKey(() => 13n);
        const eveFk = fmdFlagKeyFromDetection(J, eveDk);

        const inputs: ScanInput[] = [];
        const mk = (
            recipient: typeof me,
            flagKey: typeof fk,
            esk: bigint,
            r: bigint,
            value: bigint,
            leafIndex: number,
        ): void => {
            const enc = encryptNote({
                J,
                recipientPkD: recipient.pk_d,
                esk,
                plaintext: encodeNotePayload({ asset: 1n, value, rho: 3n, rcm: 4n }),
            });
            const clue = fmdFlag(J, flagKey, r);
            inputs.push({
                ciphertext: withClueBitsPrefix(
                    clueBitsToPrefix(clue.bits, clue.gamma),
                    enc.ciphertext,
                ),
                epk: enc.epk,
                cm: BigInt(leafIndex),
                leafIndex,
                clue,
            });
        };
        for (let i = 0; i < 8; i++) {
            const mine = i % 3 === 0;
            mk(
                mine ? me : eve,
                mine ? fk : eveFk,
                BigInt(i + 1) * 11n,
                BigInt(i + 1) * 17n,
                BigInt(100 + i),
                i,
            );
        }

        const local = await new LocalScanner(J).scan(me.ivk, inputs, dk);

        const pool = new WorkerPoolScanner({
            factory: () => makeFakeWorker(J),
            size: 3,
            chunkSize: 3,
        });
        const viaPool = await pool.scan(me.ivk, inputs, dk);
        await pool.dispose();

        expect(viaPool).toEqual(local);
    });
});
