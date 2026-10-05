import { genericCallWrapperAbi, maspAbi } from "@lelantos-org/contracts";
import { encodeAbiParameters, keccak256 } from "viem";
import { describe, expect, it } from "vitest";
import { flatten } from "../circuit/index.js";
import { BN254_FR } from "../core/field.js";
import { bytesToHex } from "../core/hex.js";
import {
    auxDigest,
    computePiHash,
    DEPOSIT_REQUEST_COMPONENTS,
    GENERIC_CALL_COMPONENTS,
    GENERIC_OUTPUT_COMPONENTS,
    genericIntentHash,
    swapIntentHash,
} from "./abi-hash.js";
import { AUX_OUTPUT_COMPONENTS, type AuxOutput } from "./deposit-request.js";

type AbiParam = { name?: string; type: string; components?: readonly AbiParam[] };
type AbiFn = { type: string; name?: string; inputs?: readonly AbiParam[] };

// `auxDigest` is the final word of the challenge preimage and covers the two
// aux fields the clue slots do not: `ephPub` and `ciphertext`. If a mutation to
// either left it unchanged, a relayer could corrupt the encrypted-note payload
// while the proof still verified.

function aux(over: Partial<AuxOutput> = {}): AuxOutput {
    return {
        clueRx: 11n,
        clueRy: 22n,
        clueQx: 55n,
        clueQy: 66n,
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

    it("changes when the clue witness changes", () => {
        expect(auxDigest([aux()])).not.toBe(auxDigest([aux({ clueQx: 56n })]));
        expect(auxDigest([aux()])).not.toBe(auxDigest([aux({ clueQy: 67n })]));
    });

    it("distinguishes output order", () => {
        const a = aux({ ephPubX: 1n });
        const b = aux({ ephPubX: 2n });
        expect(auxDigest([a, b])).not.toBe(auxDigest([b, a]));
    });

    it("pins its bytes to a known answer", () => {
        const empty = aux({ ephPubX: 34n, ciphertext: new Uint8Array([]) });
        expect(auxDigest([aux(), empty])).toBe(
            0x14ca87ecce92cf2e3c942a5d95a0b0d342baf4df3b9ec9e26ec111825ea0b781n,
        );
    });

    it("distinguishes array length (encoded as a dynamic tuple[])", () => {
        expect(auxDigest([aux()])).not.toBe(auxDigest([aux(), aux()]));
    });
});

describe("flatten", () => {
    // The challenge preimage in `PubInputs.Transact` member order, then the
    // clue triples, then the aux digest. Shown at 2×2: `10 + nIn + 4·nOut = 20`.
    it("puts the digest after the coefficients and out_aux_digest in the final slot", () => {
        const input = {
            merkle_root: 1n,
            nullifier: [2n, 3n],
            out_cm: [4n, 5n],
            public_asset_id: 6n,
            public_out: 7n,
            digest: 555n,
            recipient_address: 8n,
            chain_id: 9n,
            payer_address: 10n,
            relayer_address: 11n,
            intent_hash: 777n,
            out_clue_Rx: [12n, 15n],
            out_clue_Ry: [13n, 16n],
            out_clue_bits: [14n, 17n],
            out_aux_digest: 999n,
        };
        const words = flatten(input);
        expect(words).toHaveLength(20);
        expect(words.slice(0, 7)).toEqual([1n, 2n, 3n, 4n, 5n, 6n, 7n]);
        // `digest` directly follows `public_out`.
        expect(words[7]).toBe(555n);
        // `intent_hash` directly follows `relayer_address`, ahead of the clue slots.
        expect(words.slice(8, 13)).toEqual([8n, 9n, 10n, 11n, 777n]);
        expect(words.slice(13, 19)).toEqual([12n, 13n, 14n, 15n, 16n, 17n]);
        expect(words[19]).toBe(999n);
    });
});

// `piHash` is the Permit2 witness: the contract recomputes
// `keccak256(abi.encode(d, aux, feeAux))` and rejects the signature if it disagrees, so
// a wrong field order or width breaks every deposit with no local symptom.
// These tests derive the encoding from the canonical Foundry ABI and compare it
// with the hand-written component lists.

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
            inner: `0x${"33".repeat(32)}`,
            // Not the deposit's asset, so a dropped or misplaced field shows.
            feeAssetId: 2n,
            feeIn: 5n,
            feeInner: `0x${"44".repeat(32)}`,
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
            inner: `0x${"1".padStart(64, "0")}`,
            feeAssetId: 2n,
            feeIn: 5n,
            feeInner: `0x${"6".padStart(64, "0")}`,
        },
        auxD: {
            clueR: [10n, 11n],
            clueQ: [40n, 41n],
            ephPub: [12n, 13n],
            ciphertext: new Uint8Array([1, 2]),
        },
        feeAuxD: {
            clueR: [14n, 15n],
            clueQ: [42n, 43n],
            ephPub: [16n, 17n],
            ciphertext: new Uint8Array([3, 4, 5]),
        },
        refundD: {
            chainId: 31337n,
            publicAssetId: 1n,
            publicIn: 995n,
            payer: addr("5A5A"),
            recipient: addr("BEEF"),
            inner: `0x${"12".padStart(64, "0")}`,
            feeAssetId: 1n,
            feeIn: 22n,
            feeInner: `0x${"17".padStart(64, "0")}`,
        },
        refundAuxD: {
            clueR: [27n, 28n],
            clueQ: [44n, 45n],
            ephPub: [29n, 30n],
            ciphertext: new Uint8Array([6]),
        },
        refundFeeAuxD: {
            clueR: [31n, 32n],
            clueQ: [46n, 47n],
            ephPub: [33n, 34n],
            ciphertext: new Uint8Array([7, 8]),
        },
    } satisfies Parameters<typeof swapIntentHash>[0];

    it("matches the cross-language vector", () => {
        expect(swapIntentHash(intent)).toBe(
            // `SwapWrapperBindingTest.INTENT_VECTOR`.
            20568246496086653981650821090611381092259931261982909181487420188972474156030n,
        );
    });
});

// `GenericCallWrapper.execute` reverts `IntentMismatch` unless the withdraw proof's `intentHash`
// equals `GenericCallWrapper.intentHash(args)`. The vector is pinned identically in the Solidity
// and relayer test suites.

describe("genericIntentHash", () => {
    const addr = (tail: string) => `0x${tail.padStart(40, "0")}`;
    const word = (hex: string) => `0x${hex.padStart(64, "0")}`;
    const intent = {
        refundTo: addr("4EF0"),
        surplusTo: addr("5E55"),
        deadline: 1_900_000_000n,
        minGas: 600_000n,
        calls: [
            { target: addr("CA11"), value: 0n, data: "0xaabbccdd01" },
            { target: addr("CA12"), value: 7n, data: "0x" },
        ],
        outputs: [
            {
                minOut: 9_900_000_000_000n,
                deposit: {
                    chainId: 31337n,
                    publicAssetId: 2n,
                    publicIn: 990n,
                    payer: addr("5A5A"),
                    recipient: addr("BEEF"),
                    inner: word("1"),
                    feeAssetId: 2n,
                    feeIn: 5n,
                    feeInner: word("6"),
                },
                aux: {
                    clueR: [10n, 11n],
                    clueQ: [40n, 41n],
                    ephPub: [12n, 13n],
                    ciphertext: new Uint8Array([1, 2]),
                },
                feeAux: {
                    clueR: [14n, 15n],
                    clueQ: [42n, 43n],
                    ephPub: [16n, 17n],
                    ciphertext: new Uint8Array([3, 4, 5]),
                },
            },
            {
                minOut: 30_000_000_000n,
                deposit: {
                    chainId: 31337n,
                    publicAssetId: 3n,
                    publicIn: 3n,
                    payer: addr("5A5A"),
                    recipient: addr("BEEF"),
                    inner: word("21"),
                    feeAssetId: 0n,
                    feeIn: 0n,
                    feeInner: word("0"),
                },
                aux: {
                    clueR: [50n, 51n],
                    clueQ: [52n, 53n],
                    ephPub: [54n, 55n],
                    ciphertext: new Uint8Array([9]),
                },
                feeAux: {
                    clueR: [56n, 57n],
                    clueQ: [58n, 59n],
                    ephPub: [60n, 61n],
                    ciphertext: new Uint8Array([10, 11]),
                },
            },
        ],
        refundD: {
            chainId: 31337n,
            publicAssetId: 1n,
            publicIn: 995n,
            payer: addr("5A5A"),
            recipient: addr("BEEF"),
            inner: word("12"),
            feeAssetId: 1n,
            feeIn: 22n,
            feeInner: word("17"),
        },
        refundAuxD: {
            clueR: [27n, 28n],
            clueQ: [44n, 45n],
            ephPub: [29n, 30n],
            ciphertext: new Uint8Array([6]),
        },
        refundFeeAuxD: {
            clueR: [31n, 32n],
            clueQ: [46n, 47n],
            ephPub: [33n, 34n],
            ciphertext: new Uint8Array([7, 8]),
        },
    } satisfies Parameters<typeof genericIntentHash>[0];

    it("matches the cross-language vector", () => {
        expect(genericIntentHash(intent)).toBe(
            // `GenericCallWrapperBindingTest.INTENT_VECTOR`.
            827219559487417732596895015167420095798095380869771450310630500175677464989n,
        );
    });

    it("moves with every field it covers", () => {
        const base = genericIntentHash(intent);
        const changed = [
            { ...intent, refundTo: addr("1") },
            { ...intent, surplusTo: addr("1") },
            { ...intent, deadline: intent.deadline + 1n },
            { ...intent, minGas: intent.minGas + 1n },
            { ...intent, calls: intent.calls.slice(0, 1) },
            { ...intent, calls: [...intent.calls].reverse() },
            { ...intent, outputs: [...intent.outputs].reverse() },
            { ...intent, refundD: { ...intent.refundD, publicIn: 994n } },
        ];
        for (const other of changed) expect(genericIntentHash(other)).not.toBe(base);
    });

    it("declares Call and Output exactly as the contract does", () => {
        const execute = (genericCallWrapperAbi as readonly AbiFn[]).find(
            (i) => i.type === "function" && i.name === "execute",
        );
        const args = execute?.inputs?.[0]?.components ?? [];
        const member = (name: string) => args.find((c) => c.name === name);
        const layout = (params: readonly AbiParam[] = []): unknown[] =>
            params.map((c) => ({
                name: c.name,
                type: c.type,
                ...(c.components ? { components: layout(c.components) } : {}),
            }));

        expect(member("calls")?.type).toBe("tuple[]");
        expect(layout(member("calls")?.components)).toEqual(layout(GENERIC_CALL_COMPONENTS));
        expect(member("outputs")?.type).toBe("tuple[]");
        expect(layout(member("outputs")?.components)).toEqual(layout(GENERIC_OUTPUT_COMPONENTS));
    });
});
