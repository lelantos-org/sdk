import { describe, expect, it } from "vitest";
import { InvalidArgumentError } from "../core/errors.js";
import { BABYJUB_SUBGROUP_ORDER } from "../core/field.js";
import { bytesToHex } from "../core/hex.js";
import { hexPrivateKeyToNsk, resolveNsk } from "./key-source.js";
import { deriveNskFromPasskey, LELANTOS_PRF_SALT, prfOutputToNsk } from "./passkey.js";

// The credential is the wallet: there is no mnemonic behind a passkey, so a
// silent change to either constant here strands every wallet derived from it.

const prf = (fill: (i: number) => number = (i) => i) =>
    Uint8Array.from({ length: 32 }, (_, i) => fill(i) & 0xff);

describe("LELANTOS_PRF_SALT", () => {
    it("pins the salt", () => {
        // The authenticator's PRF is keyed by (credential, salt), so this is
        // as load-bearing as the domain tag: a different salt against the same
        // passkey is a different wallet.
        expect(bytesToHex(LELANTOS_PRF_SALT)).toBe(
            "0xcf70ce8e0c5bfb8b5db26a26b073c94af7afad0d39fee791d8cde5442ba509f4",
        );
        expect(LELANTOS_PRF_SALT).toHaveLength(32);
    });
});

describe("prfOutputToNsk", () => {
    it("pins the derivation", () => {
        // Golden vector. A change here changes every passkey-derived address,
        // so it must be deliberate.
        expect(prfOutputToNsk(prf()).toString()).toBe(
            "168664424338788028792489089955818917124515579265289117029718021816294593178",
        );
    });

    it("is deterministic", () => {
        // The whole reason PRF is the key source rather than the assertion
        // signature, which is randomized per call.
        expect(prfOutputToNsk(prf())).toBe(prfOutputToNsk(prf()));
    });

    it("is domain-separated from the private-key path", () => {
        // The same 32 bytes read as a private key must not land on the same
        // wallet, or one source could silently spend the other's notes.
        expect(prfOutputToNsk(prf())).not.toBe(hexPrivateKeyToNsk(bytesToHex(prf())));
    });

    it("lands in the subgroup", () => {
        for (const f of [() => 0, (i: number) => i, () => 0xff, (i: number) => i * 7 + 3]) {
            const nsk = prfOutputToNsk(prf(f));
            expect(nsk).toBeGreaterThan(0n);
            expect(nsk).toBeLessThan(BABYJUB_SUBGROUP_ORDER);
        }
    });

    it("rejects anything but 32 bytes", () => {
        // A short read from a misconfigured ceremony would otherwise derive a
        // wallet from truncated entropy without complaint.
        for (const len of [0, 16, 31, 33, 64]) {
            expect(() => prfOutputToNsk(new Uint8Array(len))).toThrow(InvalidArgumentError);
        }
    });

    it("keeps the PRF output out of the error", () => {
        // It is key material even when it is the wrong length.
        const bad = Uint8Array.from({ length: 8 }, () => 0xab);
        expect(() => prfOutputToNsk(bad)).toThrow(/got 8/);
        expect(() => prfOutputToNsk(bad)).not.toThrow(/abab/);
    });
});

describe("deriveNskFromPasskey", () => {
    it("evaluates against the pinned salt and reduces the result", async () => {
        let seen: Uint8Array | undefined;
        const nsk = await deriveNskFromPasskey({
            evaluatePrf: async (salt) => {
                seen = salt;
                return prf();
            },
        });
        expect(seen).toEqual(LELANTOS_PRF_SALT);
        expect(nsk).toBe(prfOutputToNsk(prf()));
    });
});

describe("resolveNsk", () => {
    it("routes the passkeyPrf source through the same reduction", () => {
        expect(resolveNsk({ type: "passkeyPrf", prf: prf() })).toBe(prfOutputToNsk(prf()));
    });
});
