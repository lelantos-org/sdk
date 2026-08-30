import { describe, expect, it } from "vitest";
import { BABYJUB_SUBGROUP_ORDER } from "../core/field.js";
import { reduceSignatureToScalar } from "./metamask.js";

// A wallet's whole identity hangs off this reduction, and `lelantosTypedDataHash`
// was pinned while the reduction itself was not.

const R = "11".repeat(32);
const S_LOW = "22".repeat(32);
const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

const sig = (r: string, s: string | bigint, v: string) =>
    `0x${r}${typeof s === "string" ? s : s.toString(16).padStart(64, "0")}${v}`;

describe("reduceSignatureToScalar", () => {
    it("pins the derivation", () => {
        // Golden vector. A change here changes every signature-derived
        // address, so it must be deliberate.
        //
        // Rotated for v2, which widened the reduction from one keccak block to
        // two so the fold into the 251-bit subgroup order stopped skewing
        // residues by ~30:29. Every v1 signature-derived address is invalid.
        expect(reduceSignatureToScalar(sig(R, S_LOW, "1b")).toString()).toBe(
            "1023816015239521581944689410812393643341180842685041365067078398366631624545",
        );
    });

    it("is stable across the two `v` encodings", () => {
        // 27/28 and 0/1 are both in the wild. Hashing the raw 65 bytes gave a
        // different wallet — and no access to the funds at the other one —
        // purely from which wallet software produced the signature.
        const a = reduceSignatureToScalar(sig(R, S_LOW, "1b"));
        const b = reduceSignatureToScalar(sig(R, S_LOW, "00"));
        const c = reduceSignatureToScalar(sig(R, S_LOW, "1c"));

        expect(b).toBe(a);
        expect(c).toBe(a);
    });

    it("is stable under s-malleability", () => {
        // `(r, s)` and `(r, n - s)` are both valid signatures over the same
        // digest; only some signers normalise to the low half.
        const low = BigInt(`0x${S_LOW}`);
        const high = SECP256K1_N - low;

        expect(reduceSignatureToScalar(sig(R, high, "1b"))).toBe(
            reduceSignatureToScalar(sig(R, low, "1b")),
        );
    });

    it("still distinguishes genuinely different signatures", () => {
        expect(reduceSignatureToScalar(sig("33".repeat(32), S_LOW, "1b"))).not.toBe(
            reduceSignatureToScalar(sig(R, S_LOW, "1b")),
        );
    });

    it("lands in the subgroup", () => {
        const nsk = reduceSignatureToScalar(sig(R, S_LOW, "1b"));
        expect(nsk).toBeGreaterThan(0n);
        expect(nsk).toBeLessThan(BABYJUB_SUBGROUP_ORDER);
    });

    it("rejects anything that is not a 65-byte signature", () => {
        // The old check accepted any even-length hex, so a truncated
        // signature derived a wallet instead of failing.
        expect(() => reduceSignatureToScalar("0xdeadbeef")).toThrow(/65 bytes/);
        expect(() => reduceSignatureToScalar(`0x${R}${S_LOW}`)).toThrow(/65 bytes/);
        expect(() => reduceSignatureToScalar(`0x${R}${S_LOW}1b00`)).toThrow(/65 bytes/);
        expect(() => reduceSignatureToScalar("not hex at all")).toThrow(/65 bytes/);
    });

    it("rejects an `s` outside the group", () => {
        expect(() => reduceSignatureToScalar(sig(R, 0n, "1b"))).toThrow(/secp256k1 group/);
        expect(() => reduceSignatureToScalar(sig(R, SECP256K1_N, "1b"))).toThrow(/secp256k1 group/);
    });
});
