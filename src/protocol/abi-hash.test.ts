import { maspAbi } from "@lelantos-org/contracts";
import { encodeAbiParameters, keccak256 } from "viem";
import { describe, expect, it } from "vitest";
import { flatten } from "../circuit/index.js";
import { BN254_FR } from "../core/field.js";
import { bytesToHex } from "../core/hex.js";
import { auxDigest, computePiHash, DEPOSIT_REQUEST_COMPONENTS } from "./abi-hash.js";
import { AUX_OUTPUT_COMPONENTS, type AuxOutput } from "./deposit-request.js";

type AbiParam = { name?: string; type: string; components?: readonly AbiParam[] };
type AbiFn = { type: string; name?: string; inputs?: readonly AbiParam[] };

// `auxDigest` is the preimage of the final PolyEval coefficient, and covers
// the two aux fields the clue slots do not: `ephPub` and `ciphertext`. If a
// mutation to either left the digest unchanged, a relayer could corrupt the
// encrypted-note payload while the proof still verified.

function aux(over: Partial<AuxOutput> = {}): AuxOutput {
    return {
        clueRx: 11n,
        clueRy: 22n,
        ephPubX: 33n,
        ephPubY: 44n,
        ciphertext: new Uint8Array([0, 0, 1, 2, 3]),
        ...over,
    };
}

describe("auxDigest", () => {
    it("is deterministic and reduced mod r", () => {
        const d = auxDigest([aux(), aux()]);
        expect(d).toBe(auxDigest([aux(), aux()]));
        expect(d).toBeLessThan(BN254_FR);
    });

    it("changes when ephPubX changes", () => {
        expect(auxDigest([aux()])).not.toBe(auxDigest([aux({ ephPubX: 34n })]));
    });

    it("changes when ephPubY changes", () => {
        expect(auxDigest([aux()])).not.toBe(auxDigest([aux({ ephPubY: 45n })]));
    });

    it("changes when the ciphertext changes", () => {
        const other = new Uint8Array([0, 0, 1, 2, 4]);
        expect(auxDigest([aux()])).not.toBe(auxDigest([aux({ ciphertext: other })]));
    });

    it("changes when the ciphertext is truncated", () => {
        const short = new Uint8Array([0, 0, 1, 2]);
        expect(auxDigest([aux()])).not.toBe(auxDigest([aux({ ciphertext: short })]));
    });

    it("changes when the clue fields change", () => {
        expect(auxDigest([aux()])).not.toBe(auxDigest([aux({ clueRx: 12n })]));
    });

    it("distinguishes output order", () => {
        const a = aux({ ephPubX: 1n });
        const b = aux({ ephPubX: 2n });
        expect(auxDigest([a, b])).not.toBe(auxDigest([b, a]));
    });

    it("distinguishes array length (encoded as a dynamic tuple[])", () => {
        expect(auxDigest([aux()])).not.toBe(auxDigest([aux(), aux()]));
    });
});

describe("flatten", () => {
    // The aux digest occupies the last slot, leaving indices 0..29 fixed, so a
    // PubInputs.sol layout only has to append.
    it("puts out_aux_digest in the final slot, index 30", () => {
        const input = {
            merkle_root: 1n,
            nullifier: [2n, 3n],
            out_cm: [4n, 5n],
            public_asset_id: 6n,
            public_in: 7n,
            public_out: 8n,
            in_cv: [
                [9n, 10n],
                [11n, 12n],
            ],
            out_cv: [
                [13n, 14n],
                [15n, 16n],
            ],
            recipient_address: 17n,
            chain_id: 18n,
            payer_address: 19n,
            relayer_address: 20n,
            out_cv_dep: [
                [21n, 22n],
                [23n, 24n],
            ],
            out_clue_Rx: [25n, 28n],
            out_clue_Ry: [26n, 29n],
            out_clue_bits: [27n, 30n],
            out_aux_digest: 999n,
        };
        const coeffs = flatten(input);
        expect(coeffs).toHaveLength(31);
        expect(coeffs[30]).toBe(999n);
        expect(coeffs[0]).toBe(1n);
        expect(coeffs[29]).toBe(30n);
    });
});

// ─── piHash vs the deployed contract ─────────────────────────────────────────
//
// `piHash` is the Permit2 witness: the contract recomputes
// `keccak256(abi.encode(d, aux))` and rejects the signature if it disagrees, so
// a wrong field order or width breaks every deposit with no local symptom.
// These derive the encoding from the canonical Foundry ABI rather than trusting
// the hand-written component list.

describe("computePiHash vs the canonical ABI", () => {
    // `submitDepositNative` is the shortest signature carrying both structs.
    const submit = (maspAbi as readonly AbiFn[]).find(
        (i) => i.type === "function" && i.name === "submitDepositNative",
    );
    if (!submit?.inputs) throw new Error("submitDepositNative missing from the canonical ABI");
    const [depositParam, auxParam] = submit.inputs;

    /** Names and types only; `internalType` is Foundry bookkeeping. */
    const layout = (params: readonly AbiParam[] = []) =>
        params.map((c) => ({ name: c.name, type: c.type }));

    it("declares DepositRequest exactly as the contract does", () => {
        expect(layout(depositParam?.components)).toEqual(layout(DEPOSIT_REQUEST_COMPONENTS));
    });

    it("declares AuxValidation.Output exactly as the contract does", () => {
        // A single struct, not an array — the second output is gone.
        expect(auxParam?.type).toBe("tuple");
        expect(layout(auxParam?.components)).toEqual(layout(AUX_OUTPUT_COMPONENTS));
    });

    it("matches a hash encoded straight from the canonical components", () => {
        const request = {
            chainId: 31337n,
            publicAssetId: 1n,
            publicIn: 1_000n,
            payer: `0x${"11".repeat(20)}`,
            recipient: `0x${"22".repeat(20)}`,
            outCm: `0x${"33".repeat(32)}`,
            cvDep: [7n, 8n] as [bigint, bigint],
            rcv: 99n,
        };
        const a = aux();
        const wire = { ...a, ciphertext: bytesToHex(a.ciphertext) };

        const fromCanonical = keccak256(
            encodeAbiParameters([depositParam, auxParam] as never, [request, wire] as never),
        );

        expect(computePiHash(request, a)).toBe(fromCanonical);
    });
});
