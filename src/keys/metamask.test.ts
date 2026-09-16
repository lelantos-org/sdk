import { describe, expect, it } from "vitest";
import { Eip1193Signer } from "../chain/signer/eip1193.js";
import { evmAddress } from "../core/brand.js";
import { BABYJUB_SUBGROUP_ORDER } from "../core/field.js";
import { deriveNskFromSigner, reduceSignatureToScalar } from "./metamask.js";

// Every signature-derived wallet depends on this reduction, so it is pinned alongside
// `lelantosTypedDataHash`.

const R = "11".repeat(32);
const S_LOW = "22".repeat(32);
const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

const sig = (r: string, s: string | bigint, v: string) =>
    `0x${r}${typeof s === "string" ? s : s.toString(16).padStart(64, "0")}${v}`;

describe("reduceSignatureToScalar", () => {
    it("pins the derivation", () => {
        // Golden vector for the version "1" two-keccak-block reduction. A change here changes
        // every signature-derived address, so it must be deliberate.
        expect(reduceSignatureToScalar(sig(R, S_LOW, "1b")).toString()).toBe(
            "1023816015239521581944689410812393643341180842685041365067078398366631624545",
        );
    });

    it("is stable across the two `v` encodings", () => {
        // Wallets emit both 27/28 and 0/1; each must derive the same wallet.
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
        // A truncated or extended signature must fail rather than derive a wallet.
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

describe("deriveNskFromSigner", () => {
    // The key-derivation prompt is the first thing a browser user sees; declining it is an answer.
    it("reports a declined prompt as USER_REJECTED derive-key, through any signer", async () => {
        const provider = {
            request: async () => {
                throw { code: 4001, message: "User rejected the request." };
            },
        };
        const signer = new Eip1193Signer(provider, evmAddress(`0x${"aa".repeat(20)}`), 1n);
        await expect(deriveNskFromSigner(signer)).rejects.toMatchObject({
            code: "USER_REJECTED",
            action: "derive-key",
        });

        const custom = {
            chainId: 1n,
            getAddress: async () => evmAddress(`0x${"aa".repeat(20)}`),
            signTypedData: async () => {
                throw Object.assign(new Error("denied"), { code: 4001 });
            },
            sendTransaction: async () => {
                throw new Error("unused");
            },
        };
        await expect(deriveNskFromSigner(custom)).rejects.toMatchObject({
            code: "USER_REJECTED",
            action: "derive-key",
        });
    });

    it("passes other signer failures through", async () => {
        const boom = new Error("ledger disconnected");
        const custom = {
            chainId: 1n,
            getAddress: async () => evmAddress(`0x${"aa".repeat(20)}`),
            signTypedData: async () => {
                throw boom;
            },
            sendTransaction: async () => {
                throw boom;
            },
        };
        await expect(deriveNskFromSigner(custom)).rejects.toBe(boom);
    });
});

describe("Eip1193Signer", () => {
    it("reports a declined transaction as USER_REJECTED send-tx", async () => {
        const provider = {
            request: async () => {
                throw { code: 4001, message: "User denied transaction signature." };
            },
        };
        const signer = new Eip1193Signer(provider, evmAddress(`0x${"aa".repeat(20)}`), 1n);
        await expect(
            signer.sendTransaction({ to: evmAddress(`0x${"bb".repeat(20)}`) }),
        ).rejects.toMatchObject({ code: "USER_REJECTED", action: "send-tx" });
    });
});
