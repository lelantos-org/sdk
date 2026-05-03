// Parity: WasmJubjub.tryDecryptNote ≡ circomlibjs decryptNote, byte-for-byte.
// Auto-skipping when wasm artifact absent.

import { beforeAll, expect, it } from "vitest";
import { Jubjub, Poseidon } from "./crypto/index.js";
import { loadWasmJubjub, wasmDescribe } from "./crypto/wasm-test-utils.js";
import { buildSpendingKey } from "./keys.js";
import { encodeNotePayload } from "./note-codec.js";
import { decryptNote, encryptNote } from "./note-encrypt.js";

wasmDescribe("WasmJubjub fused decrypt parity vs circomlibjs", () => {
    let P: Poseidon;
    let circomJ: Jubjub;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let wasmJ: any;

    beforeAll(async () => {
        P = await Poseidon.build();
        circomJ = await Jubjub.build();
        wasmJ = await loadWasmJubjub();
    });

    it("matches circomlibjs decryptNote on mine + foreign", () => {
        for (let seed = 1; seed <= 25; seed++) {
            const me = buildSpendingKey(P, circomJ, BigInt(seed));
            const eve = buildSpendingKey(P, circomJ, BigInt(seed + 1000));
            const pt = encodeNotePayload({
                asset: 1n,
                value: BigInt(seed),
                rho: BigInt(seed + 100),
                rcm: BigInt(seed + 200),
            });

            for (const recipient of [me, eve]) {
                const enc = encryptNote({
                    J: circomJ,
                    recipientPkD: recipient.pk_d,
                    esk: BigInt(seed * 7) || 1n,
                    plaintext: pt,
                });
                const viaCircom = decryptNote({ J: circomJ, ivk: me.ivk, note: enc });
                const viaWasm = decryptNote({ J: wasmJ, ivk: me.ivk, note: enc });
                expect(viaWasm).toEqual(viaCircom);
            }
        }
    });

    it("returns null on corrupted ciphertext", () => {
        const me = buildSpendingKey(P, circomJ, 42n);
        const enc = encryptNote({
            J: circomJ,
            recipientPkD: me.pk_d,
            esk: 7n,
            plaintext: encodeNotePayload({ asset: 1n, value: 99n, rho: 3n, rcm: 4n }),
        });
        enc.ciphertext[0] ^= 0xff;
        expect(decryptNote({ J: wasmJ, ivk: me.ivk, note: enc })).toBeNull();
    });

    it("returns null on garbage epk", () => {
        const me = buildSpendingKey(P, circomJ, 42n);
        const enc = encryptNote({
            J: circomJ,
            recipientPkD: me.pk_d,
            esk: 7n,
            plaintext: encodeNotePayload({ asset: 1n, value: 99n, rho: 3n, rcm: 4n }),
        });
        const bad = new Uint8Array(32).fill(0xff);
        expect(
            decryptNote({ J: wasmJ, ivk: me.ivk, note: { epk: bad, ciphertext: enc.ciphertext } }),
        ).toBeNull();
    });
});
