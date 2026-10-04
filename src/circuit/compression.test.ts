// Known answers for the witness layout and the challenge preimage, independent of the circuits
// package's vectors: `toCircomInput`'s key order and values, `flatten`'s word order, the `coeffs`
// prefix, the coefficient digest, and the Fiat-Shamir `z` over them.
//
// The pinned values reproduce under the circuits repo's reference implementation
// (`test/ref/{witness,compress}.ts`) on the same inputs.

import { createHash } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { BN254_FR } from "../core/field.js";
import { Poseidon } from "../crypto/poseidon.js";
import { TAG_DIGEST } from "../crypto/tags.js";
import { InvalidArgumentError } from "../errors/config.js";
import type { Note, SpentNote } from "../notes/note.js";
import { challengeWordCount, coeffCount } from "../protocol/shape.js";
import {
    coeffDigest,
    coeffs,
    type FlattenInput,
    fiatShamirZ,
    flatten,
    hornerEval,
    transactDigest,
} from "./compression.js";
import { type BuildOpts, circuitSignals, toCircomInput } from "./input.js";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

function spent(k: bigint): SpentNote {
    return {
        asset: k,
        value: 10n * k,
        pk: 100n + k,
        rho: 200n + k,
        rcm: 300n + k,
        nsk: 600n + k,
        d: 650n + k,
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
    };
}

/** A 2×3 witness: small enough to spell out, and not the deployed shape. */
function opts(): BuildOpts {
    return {
        publicAssetId: 1n,
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
    };
}

const SHAPE = { nIn: 2, nOut: 3 };

let P: Poseidon;
beforeAll(async () => {
    P = await Poseidon.build();
});

describe("witness and challenge layout", () => {
    it("pins toCircomInput, flatten, coeffs, the digest and z", () => {
        const bundle = toCircomInput(P, opts());
        const words = flatten(bundle);
        expect(sha256(JSON.stringify(bundle))).toBe(
            "24822194418fb0ccacd5f5a3cd4d74d792bbfb362941a68c80bf8868d694c6ac",
        );
        expect(words).toHaveLength(24);
        expect(sha256(words.join(","))).toBe(
            "e4b9191f865ac732cf486b967e56d44de16ea03e6e29c9ed1bdcfe6b08c39d79",
        );
        expect(sha256(coeffs(bundle).join(","))).toBe(
            "e36d93719d6a7f4bd957a45abe1215ecd5129a4012c789cb941eb62c5a3cc9b0",
        );
        expect(bundle.digest).toBe(
            "5634148140217643037455731994839076350527547223288659560333117893338684316631",
        );
        expect(fiatShamirZ(words)).toBe(
            10784496723773419662401551764724685587449811492115871554966240126564425348575n,
        );
    });

    it("orders the preimage as coefficients, digest, binding words, clues, aux digest", () => {
        const bundle = toCircomInput(P, opts());
        const cm = bundle.out_cm.map(BigInt);
        expect(coeffs(bundle)).toEqual([4000n, 801n, 802n, ...cm, 1n, 6n]);
        expect(flatten(bundle)).toEqual([
            ...coeffs(bundle),
            BigInt(bundle.digest),
            4001n,
            4002n,
            4003n,
            4004n,
            4005n,
            ...[3101n, 3201n, 3001n],
            ...[3102n, 3202n, 3002n],
            ...[3103n, 3203n, 3003n],
            4007n,
        ]);
        expect(coeffs(bundle)).toHaveLength(coeffCount(SHAPE));
        expect(flatten(bundle)).toHaveLength(challengeWordCount(SHAPE));
    });

    it("hashes the digest word as given", () => {
        const bundle = toCircomInput(P, opts());
        const forged: FlattenInput = { ...bundle, digest: 7n };
        expect(flatten(forged)[coeffCount(SHAPE)]).toBe(7n);
        expect(fiatShamirZ(flatten(forged))).not.toBe(fiatShamirZ(flatten(bundle)));
    });

    it("rejects a preimage with a missing digest or clue group", () => {
        // A `FlattenInput` rebuilt from a wire shape that omits a slot: the types forbid it, so
        // the absence is forced.
        const without = (key: keyof FlattenInput): FlattenInput => {
            const partial: Partial<FlattenInput> = { ...toCircomInput(P, opts()) };
            delete partial[key];
            return partial as FlattenInput;
        };
        expect(() => flatten(without("digest"))).toThrow(InvalidArgumentError);
        expect(() => flatten(without("out_clue_Rx"))).toThrow(InvalidArgumentError);
        expect(() => flatten({ ...toCircomInput(P, opts()), out_clue_bits: ["1"] })).toThrow(
            InvalidArgumentError,
        );
    });
});

describe("toCircomInput", () => {
    it("puts transactDigest of its own coefficient slots in the binding", () => {
        const bundle = toCircomInput(P, opts());
        expect(BigInt(bundle.digest)).toBe(transactDigest(bundle));
        expect(BigInt(bundle.digest)).toBe(coeffDigest(coeffs(bundle)));
    });

    it("refuses to name an asset when nothing is withdrawn", () => {
        expect(() => toCircomInput(P, { ...opts(), publicOut: 0n })).toThrow(InvalidArgumentError);
        const transfer = toCircomInput(P, { ...opts(), publicOut: 0n, publicAssetId: 0n });
        expect(transfer.public_asset_id).toBe("0");
    });

    it("projects exactly the circuit's input signals", () => {
        // `Transact`'s `signal input` set in the circuits' `transact.circom`. `digest` and
        // `y` are outputs; the binding words are not signals.
        expect(Object.keys(circuitSignals(toCircomInput(P, opts()))).sort()).toEqual(
            [
                "z",
                "merkle_root",
                "nullifier",
                "out_cm",
                "public_asset_id",
                "public_out",
                "in_asset",
                "in_value",
                "in_rho",
                "in_rcm",
                "in_nsk",
                "in_d",
                "in_path_elements",
                "in_path_indices",
                "in_is_dummy",
                "out_asset",
                "out_value",
                "out_pk",
                "out_rho",
                "out_rcm",
            ].sort(),
        );
    });
});

describe("coeffDigest", () => {
    // Recomputed block by block through the crypto layer's Poseidon, which serves arity 5 from a
    // different backend than `coeffDigest` uses.
    const fold = (words: bigint[]): bigint => {
        let h = TAG_DIGEST;
        for (let at = 0; at < words.length; at += 4) {
            const block = [0, 1, 2, 3].map((i) => words[at + i] ?? 0n);
            h = P.hash([h, ...block]);
        }
        return h;
    };

    it.each([1, 3, 4, 5, 8, 13])("folds %i words four per block", (n) => {
        const words = Array.from({ length: n }, (_, i) => 1000n + BigInt(i));
        expect(coeffDigest(words)).toBe(fold(words));
    });

    it("zero-pads only the last block", () => {
        // Padding is implicit, so a vector and its zero-extension within one block collide by
        // construction; the word count is fixed by the shape, so this is not exploitable.
        expect(coeffDigest([1n, 2n, 3n])).toBe(coeffDigest([1n, 2n, 3n, 0n]));
        expect(coeffDigest([1n, 2n, 3n, 0n])).not.toBe(coeffDigest([1n, 2n, 3n, 0n, 0n]));
    });

    it("depends on word order", () => {
        expect(coeffDigest([1n, 2n])).not.toBe(coeffDigest([2n, 1n]));
    });

    it("rejects an empty vector and unreduced words", () => {
        expect(() => coeffDigest([])).toThrow(InvalidArgumentError);
        expect(() => coeffDigest([BN254_FR])).toThrow(InvalidArgumentError);
        expect(() => coeffDigest([-1n])).toThrow(InvalidArgumentError);
    });
});

describe("hornerEval", () => {
    it("evaluates Σ c[k]·z^k mod r", () => {
        expect(hornerEval([3n, 5n, 7n], 2n)).toBe(3n + 5n * 2n + 7n * 4n);
        expect(hornerEval([BN254_FR - 1n, 1n], 1n)).toBe(0n);
    });
});
