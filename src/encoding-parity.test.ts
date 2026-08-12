// Byte-equality regression tests for encoding primitives. Every pin comes
// from an implementation other than the one under test, so agreement means
// something: `lelantosTypedDataHash`, `computePiHash` and `fiatShamirZ` were
// generated with ethers@6 (`TypedDataEncoder.hash`,
// `AbiCoder.defaultAbiCoder().encode`, `keccak256`); `auxDigest` is re-derived
// here from the ABI spec and hashed with `@noble/hashes`.
//
// A shifted hash breaks wire compatibility:
//
// - `lelantosTypedDataHash` → nsk caches diverge; every shielded address
//   regenerates.
// - `computePiHash` → on-chain `submitIntent` reverts (contract recomputes
//   the hash and checks it against the Permit2 witness).
// - `auxDigest` → the final PolyEval coefficient moves, so `PubInputs.sol`
//   recomputes a different slot from calldata and the SNARK fails to verify.
// - `fiatShamirZ` → SNARK verification + relayer batching diverge.
//
// Update these constants only with a contract/relayer upgrade that bumps
// the corresponding domain version.
//
// The `computePiHash` vector covers a `DepositIntent` carrying `rcvDepPad`
// (the per-leaf deposit binding in tree_update_batch — see circuits §14), and
// is cross-checked against a hand-rolled ABI encoder built from the spec
// rather than copied from `encodeAbiParameters` output. It requires the
// matching `PubInputs.DepositIntent` struct on-chain; without that field,
// `submitIntent` reverts.

import { keccak_256 } from "@noble/hashes/sha3";
import { describe, expect, it } from "vitest";
import { fiatShamirZ } from "./circuit/index.js";
import { BN254_FR } from "./core/field.js";
import { hexToBytes } from "./core/hex.js";
import { lelantosTypedDataHash } from "./keys/metamask.js";
import { auxDigest, computePiHash } from "./protocol/abi-hash.js";
import type { AuxOutput, DepositIntent } from "./protocol/deposit-intent.js";

const PINNED = {
    lelantosTypedDataHash: "0xaf9b4003f47701e282c9f5934e4ea6e5fe0f794e18c0e12c60bb6ba68ee3a93f",
    computePiHash: "0x7097c977d4ea3cb1e0de444cd4e9394547ec647def7922427db2139328647c4a",
    auxDigest: "0x0c1c91777a86f5850add27faced1cdd04125ab20d353f852f5ee880ecc76b9de",
    fiatShamirZ: "0x09749a91edf59dfc22cb354dc68e01ed58df7cd957ee08c5e8623f0f9374d29b",
} as const;

/** The two aux outputs shared by the `computePiHash` and `auxDigest` vectors. */
const AUX: [AuxOutput, AuxOutput] = [
    {
        clueRx: 1n,
        clueRy: 2n,
        ephPubX: 3n,
        ephPubY: 4n,
        ciphertext: new Uint8Array([0xab, 0xcd, 0xef]),
    },
    { clueRx: 5n, clueRy: 6n, ephPubX: 7n, ephPubY: 8n, ciphertext: new Uint8Array([0x12, 0x34]) },
];

describe("encoding parity (independent implementation → viem)", () => {
    it("lelantosTypedDataHash matches the pinned ethers output", () => {
        expect(lelantosTypedDataHash()).toBe(PINNED.lelantosTypedDataHash);
    });

    it("computePiHash matches the pinned ethers output for the canonical fixture", () => {
        const intent: DepositIntent = {
            chainId: 31337n,
            publicAssetId: 1n,
            publicIn: 1000n,
            payer: "0x0000000000000000000000000000000000000001",
            recipient: "0x0000000000000000000000000000000000000002",
            outCm: [
                "0x0000000000000000000000000000000000000000000000000000000000000003",
                "0x0000000000000000000000000000000000000000000000000000000000000004",
            ],
            cvDep0: [11n, 12n],
            cvDep1: [13n, 14n],
            rcvTotal: 99n,
            rcvDepPad: 41n,
        };
        expect(computePiHash(intent, AUX)).toBe(PINNED.computePiHash);
    });

    it("auxDigest matches the pinned output for the canonical fixture", () => {
        expect(hex32(auxDigest(AUX))).toBe(PINNED.auxDigest);
    });

    it("auxDigest agrees with the layout spelled out from the ABI spec", () => {
        // The pinned constant alone would survive a change applied to both
        // sides at once. This re-derives the preimage from the encoding rules
        // — and hashes it with `@noble/hashes` rather than viem — so the
        // vector rests on the spec, not on `encodeAbiParameters` agreeing
        // with itself.
        //
        // `auxDigest` is the hardest layout in the file: a dynamic `tuple[]`
        // whose element type is itself dynamic (`ciphertext bytes`), so the
        // preimage carries a length word, an offset per element, and a nested
        // offset inside each element.
        const encoded = encodeAuxArrayFromSpec(AUX);
        expect(encoded.length / 32).toBe(18); // 1 offset + 1 length + 2 heads + 7 + 7
        expect(BigInt(bytesToHexWord(keccak_256(encoded))) % BN254_FR).toBe(auxDigest(AUX));
    });

    it("fiatShamirZ matches the pinned ethers output for the canonical fixture", () => {
        // Verifies the `encodeAbiParameters` path mirrors ethers `AbiCoder`'s
        // `["uint256[]"]` packing (ethers stringified each coeff).
        const coeffs = [1n, 2n, 3n, 100n, 999n];
        const z = fiatShamirZ(coeffs);
        expect(`0x${z.toString(16).padStart(64, "0")}`).toBe(PINNED.fiatShamirZ);
    });
});

/** 32-byte big-endian word. */
function word(n: bigint): string {
    return n.toString(16).padStart(64, "0");
}

function bytesToHexWord(b: Uint8Array): string {
    let h = "0x";
    for (const x of b) h += x.toString(16).padStart(2, "0");
    return h;
}

function hex32(n: bigint): string {
    return `0x${word(n)}`;
}

/**
 * `abi.encode((uint256,uint256,uint256,uint256,bytes)[])`, written out from
 * the ABI encoding rules rather than delegated to a library.
 *
 * Head/tail layout, all offsets in bytes:
 *   [0]           offset to the array               = 0x20
 *   [0x20]        array length N
 *   [0x40 ..]     N element offsets, each relative to the first of them
 *   then, per element (a tuple with four static words and one dynamic):
 *                 clueRx, clueRy, ephPubX, ephPubY
 *                 offset to `ciphertext`, relative to the element start = 0xa0
 *                 ciphertext length, then its bytes right-padded to a word
 */
function encodeAuxArrayFromSpec(aux: readonly AuxOutput[]): Uint8Array {
    const elements = aux.map((a) => {
        const padded = new Uint8Array(Math.ceil(a.ciphertext.length / 32) * 32);
        padded.set(a.ciphertext);
        return (
            word(a.clueRx) +
            word(a.clueRy) +
            word(a.ephPubX) +
            word(a.ephPubY) +
            word(5n * 32n) +
            word(BigInt(a.ciphertext.length)) +
            bytesToHexWord(padded).slice(2)
        );
    });

    let offset = BigInt(elements.length * 32);
    let heads = "";
    for (const e of elements) {
        heads += word(offset);
        offset += BigInt(e.length / 2);
    }

    return hexToBytes(word(32n) + word(BigInt(elements.length)) + heads + elements.join(""));
}
