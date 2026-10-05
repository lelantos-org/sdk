// `tests/vectors/diversified.json` is the parity contract for diversified addresses between this
// SDK and the Rust backend. This suite fails when the committed file is stale; regenerate it with
// `npx tsx scripts/gen-diversified-vectors.ts`.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { bytesToHex, hexToBytes } from "./core/hex.js";
import { buildNoteCommitment } from "./crypto/commit.js";
import { Jubjub } from "./crypto/jubjub-wasm/index.js";
import { Poseidon } from "./crypto/poseidon.js";
import { ADDRESS_HRP, decodeAddress } from "./keys/address.js";
import { ownsAddress } from "./keys/diversified.js";
import { decodeNotePayload } from "./notes/codec.js";
import { emptyScanStats, scanNotes } from "./sync/scan.js";
import {
    buildDiversifiedVectors,
    type DiversifiedVectors,
    serializeDiversifiedVectors,
} from "./test-utils/diversified-vectors.js";

const vectorFile = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../tests/vectors/diversified.json",
);

describe("diversified vectors", () => {
    let J: Jubjub;
    let P: Poseidon;
    let fresh: DiversifiedVectors;
    beforeAll(async () => {
        J = await Jubjub.build();
        P = await Poseidon.build();
        fresh = buildDiversifiedVectors(J, P);
    });

    it("the committed file equals a fresh generation", () => {
        expect(readFileSync(vectorFile, "utf8")).toBe(serializeDiversifiedVectors(fresh));
    });

    it("covers a base whose counter-0 candidate does not decode", () => {
        const late = fresh.diversified_base.filter((b) => b.ctr > 0);
        expect(late.length).toBeGreaterThan(0);
        for (const base of late) expect(base.candidates[0]!.decodes).toBe(false);
        expect(fresh.addresses.some((a) => a.g_d_ctr > 0)).toBe(true);
        expect(fresh.addresses.some((a) => a.g_d_ctr === 0)).toBe(true);
    });

    it("tabulates h_i for i in 0..13 and both outcomes of a foreign detection", () => {
        expect(fresh.fmd.h_dec).toHaveLength(14);
        expect(fresh.fmd.clues.every((c) => c.detect_self)).toBe(true);
        expect(fresh.fmd.clues.some((c) => !c.detect_other)).toBe(true);
    });

    it("is version 2", () => {
        expect(fresh.version).toBe(2);
    });

    it("every address string decodes to the address's fields and belongs to its ivk", () => {
        const strings = fresh.addresses.map((a) => a.address_bech32);
        expect(new Set(strings).size).toBe(strings.length);
        for (const a of fresh.addresses) {
            expect(a.address_bech32).toHaveLength(195);
            expect(a.address_bech32.startsWith(`${ADDRESS_HRP}1`)).toBe(true);
            const got = decodeAddress(J, a.address_bech32);
            expect(got.d.toString()).toBe(a.d_dec);
            expect(got.pk.toString()).toBe(a.pk_dec);
            expect(bytesToHex(J.packPoint(got.pk_d))).toBe(a.pk_d_packed_hex);
            expect(bytesToHex(J.packPoint(got.ck_d))).toBe(a.ck_d_packed_hex);
            expect(ownsAddress(P, J, BigInt(a.ivk_dec), got)).toBe(true);
        }
    });

    it("every sealed output is a 96-byte plaintext in a 114-byte ciphertext its recipient scans", () => {
        for (const s of fresh.seed) {
            const address = fresh.addresses[s.address_index]!;
            const note = {
                asset: BigInt(s.asset_dec),
                value: BigInt(s.value_dec),
                rho: BigInt(s.rho_dec),
            };
            const [rcm, d] = [BigInt(s.rcm_dec), BigInt(address.d_dec)];

            const plaintext = hexToBytes(s.plaintext_hex);
            expect(plaintext).toHaveLength(96);
            expect(decodeNotePayload(plaintext)).toEqual({
                ...note,
                rseed: hexToBytes(s.rseed_hex),
                d,
            });

            const ciphertext = hexToBytes(s.ciphertext_hex);
            expect(ciphertext).toHaveLength(114);
            const position = {
                cm: buildNoteCommitment(P, { ...note, pk: BigInt(s.pk_dec), rcm }),
                leafIndex: 3,
                blockNumber: 9,
            };
            const input = {
                ciphertext,
                epk: hexToBytes(s.epk_packed_hex),
                clueR: hexToBytes(s.clue_R_packed_hex),
                ...position,
            };
            const stats = emptyScanStats();
            const hits = scanNotes(J, P, BigInt(address.ivk_dec), [input], stats);
            if (note.value === 0n) {
                // Opens, and is dropped as unspendable.
                expect(stats).toMatchObject({ scanned: 1, zeroValue: 1, hits: 0 });
            } else {
                expect(hits).toEqual([{ ...note, rcm, d, ...position }]);
            }

            // Another account of the file does not open it.
            const stranger = fresh.addresses.find((a) => a.ivk_dec !== address.ivk_dec)!;
            const strangerStats = emptyScanStats();
            expect(scanNotes(J, P, BigInt(stranger.ivk_dec), [input], strangerStats)).toEqual([]);
            expect(strangerStats.notOurs).toBe(1);
        }
        expect(fresh.seed.some((s) => s.value_dec === "0")).toBe(true);
        expect(fresh.seed.some((s) => s.value_dec !== "0")).toBe(true);
    });
});
