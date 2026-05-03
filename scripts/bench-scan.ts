// Bench harness: measure LocalScanner throughput on synthetic note batches.
//
// Run: npx tsx scripts/bench-scan.ts
//
// Reports: total ms, ms/note, notes/sec for a few batch sizes and FMD
// hit-rate scenarios. Establishes baseline before tuning.

import { BABYJUB_SUBGROUP_ORDER, type Field, Jubjub, Poseidon } from "../src/crypto/index.js";
import { WasmJubjub } from "../src/crypto/jubjub-wasm.js";
import {
    type FmdFlagKey,
    fmdFlag,
    fmdFlagKeyFromDetection,
    fmdGenDetectionKey,
} from "../src/fmd.js";
import { buildSpendingKey } from "../src/keys.js";
import { clueBitsToPrefix, encodeNotePayload, withClueBitsPrefix } from "../src/note-codec.js";
import { encryptNote } from "../src/note-encrypt.js";
import type { ScanInput } from "../src/sync.js";
import { LocalScanner } from "../src/wallet/scanner-local.js";

interface Scenario {
    label: string;
    n: number;
    /// fraction of notes that are mine (decrypt succeeds)
    mineFrac: number;
}

const scenarios: Scenario[] = [
    { label: "1k notes, 0% mine", n: 1000, mineFrac: 0.0 },
    { label: "1k notes, 5% mine", n: 1000, mineFrac: 0.05 },
];

async function main(): Promise<void> {
    const P = await Poseidon.build();
    const J = await Jubjub.build();

    const me = buildSpendingKey(P, J, 1234n);
    const eve = buildSpendingKey(P, J, 9999n);
    const dk = fmdGenDetectionKey(() => 7n);
    const fk = fmdFlagKeyFromDetection(J, dk);
    const eveDk = fmdGenDetectionKey(() => 13n);
    const eveFk = fmdFlagKeyFromDetection(J, eveDk);

    const W = await WasmJubjub.build();
    const local = new LocalScanner(J);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const wasmScanner = new LocalScanner(W as any);

    console.log("scanner bench");
    console.log("=".repeat(72));

    for (const sc of scenarios) {
        const inputs = buildBatch(J, sc, me.pk_d, eve.pk_d, fk, eveFk);
        // warm-up
        await local.scan(me.ivk, inputs.slice(0, 50), dk);
        await wasmScanner.scan(me.ivk, inputs.slice(0, 50), dk);

        const tA0 = performance.now();
        const hitsA = await local.scan(me.ivk, inputs, dk);
        const dtA = performance.now() - tA0;

        const tB0 = performance.now();
        const hitsB = await wasmScanner.scan(me.ivk, inputs, dk);
        const dtB = performance.now() - tB0;

        if (hitsA.length !== hitsB.length) {
            throw new Error(`hit count mismatch: circomlibjs=${hitsA.length} wasm=${hitsB.length}`);
        }

        const speedup = dtA / dtB;
        console.log(
            `${sc.label.padEnd(22)} hits=${hitsA.length.toString().padStart(4)}  ` +
                `circomlibjs=${dtA.toFixed(0).padStart(6)}ms  ` +
                `wasm=${dtB.toFixed(0).padStart(6)}ms  ` +
                `speedup=${speedup.toFixed(2)}x`,
        );
    }
}

function buildBatch(
    J: Jubjub,
    sc: Scenario,
    minePkD: ReturnType<typeof buildSpendingKey>["pk_d"],
    evePkD: ReturnType<typeof buildSpendingKey>["pk_d"],
    fk: FmdFlagKey,
    eveFk: FmdFlagKey,
): ScanInput[] {
    const inputs: ScanInput[] = [];
    const mineCount = Math.round(sc.n * sc.mineFrac);
    for (let i = 0; i < sc.n; i++) {
        const mine = i < mineCount;
        const enc = encryptNote({
            J,
            recipientPkD: mine ? minePkD : evePkD,
            esk: rand(i + 1),
            plaintext: encodeNotePayload({
                asset: 1n,
                value: BigInt(i + 1),
                rho: BigInt(i + 1000),
                rcm: BigInt(i + 2000),
            }),
        });
        const clue = fmdFlag(J, mine ? fk : eveFk, rand(i + 12345));
        const wire = withClueBitsPrefix(clueBitsToPrefix(clue.bits, clue.gamma), enc.ciphertext);
        inputs.push({ ciphertext: wire, epk: enc.epk, cm: BigInt(i), leafIndex: i, clue });
    }
    return inputs;
}

function rand(seed: number): Field {
    const v = BigInt(seed) * 0x9e3779b97f4a7c15n + 1n;
    return v % BABYJUB_SUBGROUP_ORDER || 1n;
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
