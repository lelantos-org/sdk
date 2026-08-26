import { mnemonicToSeedSync } from "@scure/bip39";
import { describe, expect, it } from "vitest";
import { isWalletError } from "../core/errors.js";
import { BN254_FR } from "../crypto/index.js";
import { ADDRESS_HRP } from "./address.js";
import {
    accountPath,
    deriveAccount,
    deriveChildHardened,
    LELANTOS_COIN_TYPE,
    masterFromSeed,
    mnemonicToAccountKey,
    ZIP32_PURPOSE,
} from "./hd.js";
import { mnemonicToNsk } from "./key-source.js";
import { deriveKeysFromMnemonic } from "./keys.js";

const TEST_MNEMONIC = "test test test test test test test test test test test junk";

function seedFor(mnemonic = TEST_MNEMONIC): Uint8Array {
    return mnemonicToSeedSync(mnemonic);
}

describe("hd / ZIP-32-lite", () => {
    it("masterFromSeed is deterministic", () => {
        const a = masterFromSeed(seedFor());
        const b = masterFromSeed(seedFor());
        expect(a.nsk).toBe(b.nsk);
        expect(Array.from(a.chainCode)).toEqual(Array.from(b.chainCode));
        expect(a.depth).toBe(0);
        expect(a.chainCode).toHaveLength(32);
    });

    it("nsk always in [1, BN254_FR)", () => {
        const seed = seedFor();
        for (const account of [0, 1, 5, 100, 0x7fffffff]) {
            const esk = deriveAccount(seed, account);
            expect(esk.nsk).toBeGreaterThanOrEqual(1n);
            expect(esk.nsk).toBeLessThan(BN254_FR);
        }
    });

    it("different accounts produce different nsk", () => {
        const seed = seedFor();
        const a0 = deriveAccount(seed, 0).nsk;
        const a1 = deriveAccount(seed, 1).nsk;
        const a5 = deriveAccount(seed, 5).nsk;
        expect(a0).not.toBe(a1);
        expect(a0).not.toBe(a5);
        expect(a1).not.toBe(a5);
    });

    it("same account is idempotent", () => {
        const seed = seedFor();
        expect(deriveAccount(seed, 7).nsk).toBe(deriveAccount(seed, 7).nsk);
    });

    it("different seeds produce different account-0 nsk", () => {
        const otherMnemonic =
            "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
        const a = deriveAccount(seedFor(), 0).nsk;
        const b = deriveAccount(seedFor(otherMnemonic), 0).nsk;
        expect(a).not.toBe(b);
    });

    it("rejects negative or non-hardened-range account indices", () => {
        const seed = seedFor();
        expect(() => deriveAccount(seed, -1)).toThrow();
        expect(() => deriveAccount(seed, 0x80000000)).toThrow();
        expect(() => deriveAccount(seed, 1.5)).toThrow();
    });

    it("deriveChildHardened rejects out-of-range indices", () => {
        const master = masterFromSeed(seedFor());
        expect(() => deriveChildHardened(master, -1)).toThrow();
        expect(() => deriveChildHardened(master, 0x80000000)).toThrow();
    });

    it("path matches manual m/32'/coin'/account' walk", () => {
        const seed = seedFor();
        const master = masterFromSeed(seed);
        const purpose = deriveChildHardened(master, ZIP32_PURPOSE);
        const coin = deriveChildHardened(purpose, LELANTOS_COIN_TYPE);
        const acct = deriveChildHardened(coin, 3);
        const direct = deriveAccount(seed, 3);
        expect(acct.nsk).toBe(direct.nsk);
        expect(Array.from(acct.chainCode)).toEqual(Array.from(direct.chainCode));
        expect(acct.depth).toBe(3);
    });

    it("mnemonicToAccountKey === deriveAccount(seed, ...)", () => {
        const a = mnemonicToAccountKey(TEST_MNEMONIC, 2);
        const b = deriveAccount(seedFor(), 2);
        expect(a.nsk).toBe(b.nsk);
    });

    it("mnemonicToNsk default account is 0", () => {
        expect(mnemonicToNsk(TEST_MNEMONIC)).toBe(mnemonicToNsk(TEST_MNEMONIC, 0));
    });

    it("accountPath renders canonical string", () => {
        expect(accountPath(0)).toBe(`m/${ZIP32_PURPOSE}'/${LELANTOS_COIN_TYPE}'/0'`);
        expect(accountPath(7)).toBe(`m/${ZIP32_PURPOSE}'/${LELANTOS_COIN_TYPE}'/7'`);
        expect(() => accountPath(-1)).toThrow();
    });

    // Mnemonic and account index are both caller input, so both failures have
    // to carry a code. Each threw a bare `Error` before.
    it("reports bad caller input as INVALID_ARGUMENT", () => {
        for (const call of [
            () => mnemonicToAccountKey("not a mnemonic"),
            () => mnemonicToAccountKey(TEST_MNEMONIC, -1),
            () => mnemonicToAccountKey(TEST_MNEMONIC, 1.5),
            () => accountPath(2 ** 31),
        ]) {
            let thrown: unknown;
            try {
                call();
            } catch (err) {
                thrown = err;
            }
            expect(isWalletError(thrown, "INVALID_ARGUMENT")).toBe(true);
        }
    });

    it("keeps the mnemonic out of the rejection message", () => {
        const secret = "abandon abandon abandon not-a-word";
        try {
            mnemonicToAccountKey(secret);
            throw new Error("expected a throw");
        } catch (err) {
            expect((err as Error).message).not.toContain(secret);
        }
    });

    it("deriveKeysFromMnemonic yields distinct addresses per account", async () => {
        const r0 = await deriveKeysFromMnemonic({ mnemonic: TEST_MNEMONIC, account: 0 });
        const r1 = await deriveKeysFromMnemonic({ mnemonic: TEST_MNEMONIC, account: 1 });
        expect(r0.address.startsWith(ADDRESS_HRP)).toBe(true);
        expect(r1.address.startsWith(ADDRESS_HRP)).toBe(true);
        expect(r0.address).not.toBe(r1.address);
        expect(r0.nsk).not.toBe(r1.nsk);
        expect(r0.keys.nsk).toBe(r0.nsk);
    });
});
