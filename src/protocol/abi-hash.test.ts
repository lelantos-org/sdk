import { maspAbi } from "@lelantos-org/contracts";
import { encodeAbiParameters, keccak256 } from "viem";
import { describe, expect, it } from "vitest";
import { flatten } from "../circuit/index.js";
import { BN254_FR } from "../core/field.js";
import { bytesToHex } from "../core/hex.js";
import {
    auxDigest,
    computePiHash,
    DEPOSIT_REQUEST_COMPONENTS,
    swapIntentHash,
} from "./abi-hash.js";
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

    it("pins its bytes to a known answer", () => {
        const empty = aux({ ephPubX: 34n, ciphertext: new Uint8Array([]) });
        expect(auxDigest([aux(), empty])).toBe(
            0x113f30d8b0ce6d4e83ea0aa1b6be67d092bd983d3be15022cbfa7b725492168cn,
        );
    });

    it("distinguishes array length (encoded as a dynamic tuple[])", () => {
        expect(auxDigest([aux()])).not.toBe(auxDigest([aux(), aux()]));
    });
});

describe("flatten", () => {
    // The aux digest occupies the last slot, leaving indices 0..30 fixed, so a
    // PubInputs.sol layout only has to append.
    it("puts out_aux_digest in the final slot, index 31", () => {
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
            intent_hash: 777n,
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
        expect(coeffs).toHaveLength(32);
        expect(coeffs[31]).toBe(999n);
        expect(coeffs[0]).toBe(1n);
        expect(coeffs[30]).toBe(30n);
        // `intentHash` directly follows `relayer`, ahead of the clue slots — the
        // `PubInputs.Transact` member order.
        expect(coeffs[23]).toBe(20n);
        expect(coeffs[24]).toBe(777n);
        expect(coeffs[25]).toBe(25n);
    });
});

// ─── piHash vs the deployed contract ─────────────────────────────────────────
//
// `piHash` is the Permit2 witness: the contract recomputes
// `keccak256(abi.encode(d, aux, feeAux))` and rejects the signature if it disagrees, so
// a wrong field order or width breaks every deposit with no local symptom.
// These tests derive the encoding from the canonical Foundry ABI and compare it
// with the hand-written component list.

describe("computePiHash vs the canonical ABI", () => {
    // `depositAuthorized` is the shortest signature carrying both structs:
    // `deposit` interposes the Permit2 sig between them.
    const submit = (maspAbi as readonly AbiFn[]).find(
        (i) => i.type === "function" && i.name === "depositAuthorized",
    );
    if (!submit?.inputs) throw new Error("depositAuthorized missing from the canonical ABI");
    const [depositParam, auxParam, feeAuxParam] = submit.inputs;

    /** Names and types only; `internalType` is Foundry bookkeeping. */
    const layout = (params: readonly AbiParam[] = []) =>
        params.map((c) => ({ name: c.name, type: c.type }));

    it("declares DepositRequest exactly as the contract does", () => {
        expect(layout(depositParam?.components)).toEqual(layout(DEPOSIT_REQUEST_COMPONENTS));
    });

    it("declares AuxValidation.Output exactly as the contract does", () => {
        // Two structs, not an array: one per leaf a deposit mints (the
        // depositor's note and the note paying the flusher).
        expect(auxParam?.type).toBe("tuple");
        expect(layout(auxParam?.components)).toEqual(layout(AUX_OUTPUT_COMPONENTS));
        expect(feeAuxParam?.type).toBe("tuple");
        expect(layout(feeAuxParam?.components)).toEqual(layout(AUX_OUTPUT_COMPONENTS));
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
            // Not the deposit's asset, so a dropped or misplaced field shows.
            feeAssetId: 2n,
            feeIn: 5n,
            feeCm: `0x${"44".repeat(32)}`,
            feeCvDep: [9n, 10n] as [bigint, bigint],
            feeRcv: 98n,
        };
        const a = aux();
        const wire = { ...a, ciphertext: bytesToHex(a.ciphertext) };

        const fromCanonical = keccak256(
            encodeAbiParameters(
                [depositParam, auxParam, auxParam] as never,
                [request, wire, wire] as never,
            ),
        );

        expect(computePiHash(request, a, a)).toBe(fromCanonical);
    });
});

// ─── swap intent hash ────────────────────────────────────────────────────────
//
// `SwapWrapper.swap` reverts `IntentMismatch` unless the withdraw proof's
// `intentHash` equals `SwapWrapper._intentHash(args)`. The vector below is
// pinned identically in the Solidity and relayer test suites, so an encoding
// mismatch on any side fails that side's tests before reaching the chain.

describe("swapIntentHash", () => {
    const addr = (tail: string) => `0x${tail.padStart(40, "0")}`;
    const intent = {
        refundTo: addr("4EF0"),
        tokenOut: addr("B0B0"),
        minOut: 9_900_000_000_000n,
        adapter: addr("ADA7"),
        deadline: 1_900_000_000n,
        depositD: {
            chainId: 31337n,
            publicAssetId: 2n,
            publicIn: 990n,
            payer: addr("5A5A"),
            recipient: addr("BEEF"),
            outCm: `0x${"1".padStart(64, "0")}`,
            cvDep: [2n, 3n] as [bigint, bigint],
            rcv: 4n,
            feeAssetId: 2n,
            feeIn: 5n,
            feeCm: `0x${"6".padStart(64, "0")}`,
            feeCvDep: [7n, 8n] as [bigint, bigint],
            feeRcv: 9n,
        },
        auxD: { clueR: [10n, 11n], ephPub: [12n, 13n], ciphertext: new Uint8Array([1, 2]) },
        feeAuxD: {
            clueR: [14n, 15n],
            ephPub: [16n, 17n],
            ciphertext: new Uint8Array([3, 4, 5]),
        },
        refundD: {
            chainId: 31337n,
            publicAssetId: 1n,
            publicIn: 995n,
            payer: addr("5A5A"),
            recipient: addr("BEEF"),
            outCm: `0x${"12".padStart(64, "0")}`,
            cvDep: [19n, 20n] as [bigint, bigint],
            rcv: 21n,
            feeAssetId: 1n,
            feeIn: 22n,
            feeCm: `0x${"17".padStart(64, "0")}`,
            feeCvDep: [24n, 25n] as [bigint, bigint],
            feeRcv: 26n,
        },
        refundAuxD: { clueR: [27n, 28n], ephPub: [29n, 30n], ciphertext: new Uint8Array([6]) },
        refundFeeAuxD: {
            clueR: [31n, 32n],
            ephPub: [33n, 34n],
            ciphertext: new Uint8Array([7, 8]),
        },
    } satisfies Parameters<typeof swapIntentHash>[0];

    it("matches the cross-language vector", () => {
        expect(swapIntentHash(intent)).toBe(
            // `SwapWrapperBindingTest.INTENT_VECTOR`.
            17537988237215357429810858075676193989150518723851377084809783452071645726238n,
        );
    });
});
