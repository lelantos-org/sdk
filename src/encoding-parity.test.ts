// Byte-equality regression tests for encoding primitives. Pinned values
// were generated with the ethers@6 implementation (`TypedDataEncoder.hash`,
// `AbiCoder.defaultAbiCoder().encode`, `keccak256`) over the same inputs;
// a shifted hash breaks wire compatibility:
//
// - `lelantosTypedDataHash` → nsk caches diverge; every shielded address
//   regenerates.
// - `computePiHash` → on-chain `submitIntent` reverts (contract recomputes
//   the hash and checks it against the Permit2 witness).
// - `fiatShamirZ` → SNARK verification + relayer batching diverge.
//
// Update these constants only with a contract/relayer upgrade that bumps
// the corresponding domain version.

import { describe, expect, it } from "vitest";
import { type AuxOutput, computePiHash, type DepositIntent } from "./bundle/permit2.js";
import { fiatShamirZ } from "./bundle/snark-compression.js";
import { lelantosTypedDataHash } from "./keys/metamask.js";

const PINNED = {
    lelantosTypedDataHash: "0xaf9b4003f47701e282c9f5934e4ea6e5fe0f794e18c0e12c60bb6ba68ee3a93f",
    computePiHash: "0x941860300d6e62d4217a591ddb84af26a4aabb493abbe1ee3ece3c76818fba96",
    fiatShamirZ: "0x09749a91edf59dfc22cb354dc68e01ed58df7cd957ee08c5e8623f0f9374d29b",
} as const;

describe("encoding parity (ethers → viem)", () => {
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
        };
        const aux: [AuxOutput, AuxOutput] = [
            {
                clueRx: 1n,
                clueRy: 2n,
                ephPubX: 3n,
                ephPubY: 4n,
                ciphertext: new Uint8Array([0xab, 0xcd, 0xef]),
            },
            {
                clueRx: 5n,
                clueRy: 6n,
                ephPubX: 7n,
                ephPubY: 8n,
                ciphertext: new Uint8Array([0x12, 0x34]),
            },
        ];
        expect(computePiHash(intent, aux)).toBe(PINNED.computePiHash);
    });

    it("fiatShamirZ matches the pinned ethers output for the canonical fixture", () => {
        // Verifies the `encodeAbiParameters` path mirrors ethers `AbiCoder`'s
        // `["uint256[]"]` packing (ethers stringified each coeff).
        const coeffs = [1n, 2n, 3n, 100n, 999n];
        const z = fiatShamirZ(coeffs);
        expect(`0x${z.toString(16).padStart(64, "0")}`).toBe(PINNED.fiatShamirZ);
    });
});
