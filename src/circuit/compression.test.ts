// Known answers for the witness layout and the challenge preimage, independent of the circuits
// package's vectors: `toCircomInput`'s key order and values, `flatten`'s word order, the `coeffs`
// prefix, and the Fiat-Shamir `z` over them.

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Jubjub } from "../crypto/jubjub-wasm/index.js";
import { Poseidon } from "../crypto/poseidon.js";
import type { Note, SpentNote } from "../notes/note.js";
import { coeffs, fiatShamirZ, flatten } from "./compression.js";
import { toCircomInput } from "./input.js";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

function spent(k: bigint): SpentNote {
    return {
        asset: k,
        value: 10n * k,
        pk: 100n + k,
        rho: 200n + k,
        rcm: 300n + k,
        rcv: 400n + k,
        rcvDep: 500n + k,
        nsk: 600n + k,
        cm: 700n + k,
        nf: 800n + k,
        leafIndex: Number(k),
        pathElements: [
            [900n + k, 901n + k, 902n + k],
            [903n + k, 904n + k, 905n + k],
        ],
        pathIndices: [Number(k % 4n), 3],
        isDummy: k === 2n,
    };
}

function note(k: bigint): Note {
    return {
        asset: k,
        value: 20n * k,
        pk: 1100n + k,
        rho: 1200n + k,
        rcm: 1300n + k,
        rcv: 1400n + k,
        rcvDep: 1500n + k,
    };
}

describe("witness and challenge layout", () => {
    it("pins toCircomInput, flatten, coeffs and z", async () => {
        const [P, J] = await Promise.all([Poseidon.build(), Jubjub.build()]);
        const bundle = toCircomInput(P, J, {
            publicAssetId: 1n,
            publicIn: 5n,
            publicOut: 6n,
            inputs: [spent(1n), spent(2n)],
            outputs: [note(1n), note(2n), note(3n)],
            outputClues: [1n, 2n, 3n].map((k) => ({
                clueBits: 3000n + k,
                clueRx: 3100n + k,
                clueRy: 3200n + k,
            })),
            merkleRoot: 4000n,
            recipientAddress: 4001n,
            chainId: 4002n,
            payerAddress: 4003n,
            relayerAddress: 4004n,
            intentHash: 4005n,
            z: 4006n,
            outputAuxDigest: 4007n,
        });
        const words = flatten(bundle);
        expect(sha256(JSON.stringify(bundle))).toBe(
            "915058f20cfb2152bd7a9659803ab2928b7b2b4ed6f09a7b74a8d3ad1717cfdd",
        );
        expect(words).toHaveLength(40);
        expect(sha256(words.join(","))).toBe(
            "e063620195f2dcbd4a1a80b59dcc15d73c0c1c4a10f9c31f3ed546e69018eed1",
        );
        expect(sha256(coeffs(bundle).join(","))).toBe(
            "2788208d65a90484075aec67408f555662656ea1ed402d1e16d1da5addd4cfb0",
        );
        expect(fiatShamirZ(words)).toBe(
            7190691073540536802505347263714203278493052541595746418932144191286669808008n,
        );
    });
});
