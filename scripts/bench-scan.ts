// Bench harness for the note-scan hot path.
//
// Run: npm run bench:scan
//
// Two sections:
//   primitives — the wasm curve ops in isolation, where sync time is spent.
//   scan       — end-to-end `scanNotes` throughput at a few hit rates.
//
// Scalars are full-width (mod BABYJUB_SUBGROUP_ORDER, ~251 bits). `mul_scalar`
// runs `n.bits()` iterations, so a short scalar understates its cost.
//
// `fmdTest` is reported for reference; there is no client-side FMD pre-filter
// (see `src/sync/scanner.ts`). It shares `decompress` and `in_subgroup` with
// trial-decrypt and tracks the same optimisations.

import { BABYJUB_SUBGROUP_ORDER, type Field, Jubjub, Poseidon } from "../src/crypto/index.js";
import {
    fmdClueKeyFromRoot,
    fmdExpandDetectionKey,
    fmdExpandFlagKey,
    fmdFlag,
    fmdTest,
} from "../src/fmd/index.js";
import { buildSpendingKey } from "../src/keys/keys.js";
import { clueBitsToPrefix, encodeNotePayload, withClueBitsPrefix } from "../src/notes/codec.js";
import { encryptNote } from "../src/notes/encrypt.js";
import { type ScanInput, scanNotes } from "../src/sync/scan.js";
import { LocalScanner } from "../src/sync/scanner.js";

/** Deterministic full-width scalar, so runs are comparable across commits. */
function scalar(seed: number): Field {
    let v = BigInt(seed) * 0x9e3779b97f4a7c15n + 0xbf58476d1ce4e5b9n;
    v = (v * v) % BABYJUB_SUBGROUP_ORDER;
    return v === 0n ? 1n : v;
}

/** Median-of-5 µs/op. The median is used because GC pauses skew the mean. */
function bench(label: string, iters: number, fn: (i: number) => void): number {
    for (let i = 0; i < Math.min(iters, 200); i++) fn(i);
    const runs: number[] = [];
    for (let r = 0; r < 5; r++) {
        const t = performance.now();
        for (let i = 0; i < iters; i++) fn(i);
        runs.push(((performance.now() - t) * 1000) / iters);
    }
    runs.sort((a, b) => a - b);
    const us = runs[2] as number;
    console.log(`  ${label.padEnd(28)} ${us.toFixed(1).padStart(8)} us/op`);
    return us;
}

async function main(): Promise<void> {
    const P = await Poseidon.build();
    const J = await Jubjub.build();

    const me = buildSpendingKey(P, J, 1234n);
    const eve = buildSpendingKey(P, J, 9999n);

    const pt = J.mulPointEscalar(J.base8, scalar(1));
    const packed = J.packPoint(pt);
    const scalars = Array.from({ length: 512 }, (_, i) => scalar(i + 2));

    console.log("primitives");
    console.log("=".repeat(48));
    const dec = bench("unpackPoint (decompress)", 2000, () => {
        J.unpackPoint(packed);
    });
    const sub = bench("inSubgroup", 2000, () => {
        J.inSubgroup(pt);
    });
    bench("packPoint", 5000, () => {
        J.packPoint(pt);
    });
    const mul = bench("mulPointEscalar (251-bit)", 1000, (i) => {
        J.mulPointEscalar(pt, scalars[i % scalars.length] as Field);
    });
    bench("addPoint", 5000, () => {
        J.addPoint(pt, pt);
    });
    bench("poseidon6 (JS)", 2000, () => {
        P.hash([1n, 2n, 3n, 4n, 5n, 6n]);
    });
    console.log(`  ${"—".repeat(28)}`);
    console.log(
        `  decode_subgroup_point      ${(dec + sub).toFixed(1).padStart(8)} us  (decompress + inSubgroup)`,
    );

    // Foreign notes: the dominant case in a firehose sync.
    const N = 2000;
    const detection = fmdExpandDetectionKey(J, P, me.dk, 5);
    const eveFlag = fmdExpandFlagKey(J, P, fmdClueKeyFromRoot(J, eve.dk), 5);
    const clues = Array.from({ length: N }, (_, i) => fmdFlag(J, P, eveFlag, scalar(i + 5000)));
    const foreign = buildBatch(J, N, 0, me.pk_d, eve.pk_d);

    console.log("\nper-note");
    console.log("=".repeat(48));
    // Reused one-element batch: `scanNotes` takes an array, and allocating one
    // per iteration would also measure the allocator.
    const single: ScanInput[] = [foreign[0]!];
    const decrypt = bench("try_decrypt_note (not mine)", N, (i) => {
        single[0] = foreign[i % N]!;
        scanNotes(J, me.ivk, single);
    });
    const fmd = bench("fmdTest (not mine)", N, (i) => {
        fmdTest(J, P, detection, clues[i % N]!);
    });
    console.log(`  ${"—".repeat(28)}`);
    console.log(
        `  decode share of decrypt    ${((100 * (dec + sub)) / decrypt).toFixed(0).padStart(7)}%`,
    );
    console.log(`  fmdTest / decrypt          ${(fmd / decrypt).toFixed(2).padStart(8)}x`);
    // Trial-decrypt performs two 251-bit scalar mults: the subgroup check on
    // epk and the ECDH. Together they set the floor for this path.
    console.log(
        `  2x scalar mult share       ${((100 * (sub + mul)) / decrypt).toFixed(0).padStart(7)}%`,
    );

    console.log("\nend-to-end scan");
    console.log("=".repeat(48));
    const scanner = new LocalScanner(J);
    const batch = 1000;
    for (const minePercent of [0, 5]) {
        const inputs = buildBatch(J, batch, minePercent / 100, me.pk_d, eve.pk_d);
        await scanner.scan(me.ivk, inputs.slice(0, 100));
        const t = performance.now();
        const hits = await scanner.scan(me.ivk, inputs);
        const ms = performance.now() - t;
        console.log(
            `  ${batch} notes, ${String(minePercent).padStart(2)}% mine     ` +
                `${ms.toFixed(0).padStart(6)} ms  ` +
                `${((ms * 1000) / batch).toFixed(0).padStart(5)} us/note  hits=${hits.length}`,
        );
    }
}

function buildBatch(
    J: Jubjub,
    n: number,
    mineFrac: number,
    minePkD: ReturnType<typeof buildSpendingKey>["pk_d"],
    evePkD: ReturnType<typeof buildSpendingKey>["pk_d"],
): ScanInput[] {
    const mineCount = Math.round(n * mineFrac);
    const inputs: ScanInput[] = [];
    for (let i = 0; i < n; i++) {
        const enc = encryptNote({
            J,
            recipientPkD: i < mineCount ? minePkD : evePkD,
            esk: scalar(i + 1),
            plaintext: encodeNotePayload({
                asset: 1n,
                value: BigInt(i + 1),
                rho: BigInt(i + 1000),
                rcm: BigInt(i + 2000),
                rcvDep: BigInt(i + 3000),
            }),
        });
        // Clue bits are a wire prefix on the ciphertext; scanNotes strips them.
        const bits = new Uint8Array([i & 0x1f]);
        const wire = withClueBitsPrefix(clueBitsToPrefix(bits, 5), enc.ciphertext);
        inputs.push({
            ciphertext: wire,
            epk: enc.epk,
            cm: BigInt(i),
            leafIndex: i,
            blockNumber: i,
        });
    }
    return inputs;
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
