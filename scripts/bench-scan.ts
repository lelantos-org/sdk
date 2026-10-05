// Bench harness for the note-scan hot path.
//
// Run: npm run bench:scan
//
// Sections:
//   primitives — the wasm curve ops in isolation, where sync time is spent,
//                and the two steps of a clue bit: the arity-6 hash and its
//                Jacobi symbol. `inSubgroup` is not on the decrypt path,
//                which clears the cofactor instead; it is reported for
//                reference.
//   per-note   — one trial decrypt and one `fmdTest` on a foreign note, and
//                one full scan of an own note: decrypt, then the commitment,
//                ephemeral-key and clue checks. The own note is timed alone
//                and as one of a batch, which shares the per-scan keys.
//   scan       — end-to-end `LocalScanner.scan` throughput at a few hit rates.
//
// Scalars are full-width: a 300-bit value reduced mod BABYJUB_SUBGROUP_ORDER,
// ~251 bits. `mul_scalar` runs `n.bits()` iterations, so a short scalar
// understates its cost.
//
// `fmdTest` is reported for reference: the scan path does not call it (see
// `src/sync/scanner.ts`). A hit recomputes its clue instead.

import { sealOutput } from "../src/bundle/common.js";
import {
    BABYJUB_SUBGROUP_ORDER,
    BN254_FR,
    type Field,
    Jubjub,
    Poseidon,
} from "../src/crypto/index.js";
import { jacobiSymbol } from "../src/crypto/sqrt.js";
import { fmdTest } from "../src/fmd/clue.js";
import { FMD_DEFAULT_GAMMA } from "../src/fmd/keys.js";
import { buildSpendingKey, detectionKeyFor, type ViewingKey } from "../src/keys/keys.js";
import { stripClueBitsPrefix } from "../src/notes/codec.js";
import { type ScanInput, scanNotes } from "../src/sync/scan.js";
import { LocalScanner } from "../src/sync/scanner.js";
import { recipientAt, sealedScanInput } from "../src/test-utils/outputs.js";

/** Deterministic full-width scalar, so runs are comparable across commits. */
function scalar(seed: number): Field {
    // `v` is about 75 bits: its fourth power exceeds the order, its square does not.
    let v = BigInt(seed) * 0x9e3779b97f4a7c15n + 0xbf58476d1ce4e5b9n;
    v = v ** 4n % BABYJUB_SUBGROUP_ORDER;
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

    const me = buildSpendingKey(P, 1234n);
    const eve = buildSpendingKey(P, 9999n);

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
    bench(`poseidon6 (${P.backend})`, 2000, () => {
        P.hash([1n, 2n, 3n, 4n, 5n, 6n]);
    });
    bench("jacobiSymbol (BN254_FR)", 5000, (i) => {
        jacobiSymbol(scalars[i % scalars.length] as Field, BN254_FR);
    });
    console.log(`  ${"—".repeat(28)}`);
    console.log(
        `  decode_subgroup_point      ${(dec + sub).toFixed(1).padStart(8)} us  (decompress + inSubgroup)`,
    );

    // Foreign notes: the dominant case in a firehose sync.
    const N = 2000;
    const detection = detectionKeyFor(P, me);
    const foreign = buildBatch(J, P, N, 0, me, eve);
    const clues = foreign.map((inp) => ({
        R: inp.clueR,
        // Low byte of the big-endian prefix, which holds all γ bits.
        bits: stripClueBitsPrefix(inp.ciphertext).prefix.subarray(1),
        gamma: FMD_DEFAULT_GAMMA,
    }));
    const own = buildBatch(J, P, 200, 1, me, eve);

    console.log("\nper-note");
    console.log("=".repeat(48));
    // Reused one-element batch: `scanNotes` takes an array, and allocating one
    // per iteration would also measure the allocator.
    // Each call also derives the scan's FMD root secret: one Poseidon hash.
    const single: ScanInput[] = [foreign[0]!];
    const decrypt = bench("try_decrypt_note (not mine)", N, (i) => {
        single[0] = foreign[i % N]!;
        scanNotes(J, P, me.ivk, single);
    });
    const fmd = bench("fmdTest (not mine)", N, (i) => {
        fmdTest(J, P, detection, clues[i % N]!);
    });
    bench("scan one note (mine)", own.length, (i) => {
        single[0] = own[i % own.length]!;
        scanNotes(J, P, me.ivk, single);
    });
    // One scan over all of them, as a sync page is scanned: the detection key and the
    // address's `pk` and `g_d`, which the one-note scan above builds every time, are built once.
    const batched = bench(`scan ${own.length} notes (mine)`, 2, () => {
        scanNotes(J, P, me.ivk, own);
    });
    console.log(`  ${"—".repeat(28)}`);
    console.log(`  per note (mine), batched   ${(batched / own.length).toFixed(1).padStart(8)} us`);
    console.log(
        `  decode share of decrypt    ${((100 * (dec + sub)) / decrypt).toFixed(0).padStart(7)}%`,
    );
    console.log(`  fmdTest / decrypt          ${(fmd / decrypt).toFixed(2).padStart(8)}x`);
    // Trial-decrypt performs one 251-bit scalar mult, the ECDH. `epk`'s cofactor
    // is cleared by three doublings; see `wasm/jubjub/src/decrypt.rs`.
    console.log(`  ECDH mult share            ${((100 * mul) / decrypt).toFixed(0).padStart(7)}%`);

    console.log("\nend-to-end scan");
    console.log("=".repeat(48));
    const scanner = new LocalScanner(J, P);
    const batch = 1000;
    for (const minePercent of [0, 5]) {
        const inputs = buildBatch(J, P, batch, minePercent / 100, me, eve);
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

/**
 * Honest outputs to default addresses: the first `mineFrac` of them to `mine`, the rest to `eve`.
 *
 * `scanNotes` rebuilds the commitment, the ephemeral key and the clue from the decrypted plaintext
 * and rejects a mismatch, so each is sealed as a wallet seals it.
 */
function buildBatch(
    J: Jubjub,
    P: Poseidon,
    n: number,
    mineFrac: number,
    mine: ViewingKey,
    eve: ViewingKey,
): ScanInput[] {
    const mineCount = Math.round(n * mineFrac);
    const toMine = recipientAt(P, J, mine);
    const toEve = recipientAt(P, J, eve);
    // Fixed, so runs are comparable across commits.
    const outgoingKey = new Uint8Array(32).fill(7);
    return Array.from({ length: n }, (_, i) => {
        const sealed = sealOutput(J, P, {
            outgoingKey,
            chainId: 1n,
            rho: BigInt(i + 1000),
            asset: 1n,
            value: BigInt(i + 1),
            recipient: i < mineCount ? toMine : toEve,
            nullifiers: [],
        });
        return sealedScanInput(P, J, sealed, { leafIndex: i, blockNumber: i });
    });
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
