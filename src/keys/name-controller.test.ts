import { privateKeyToAddress } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { BN254_FR } from "../core/field.js";
import { InvalidArgumentError } from "../errors/config.js";
import { deriveNameControllerKey } from "./name-controller.js";

describe("deriveNameControllerKey", () => {
    // Recomputed outside the SDK: blake2b-256(domain || LE32(nsk) || 0x00), then the address.
    it.each([
        [
            1n,
            "0x1e2819505105e7b8304438b97c7ab2d445d6fa658c38ddc217f86a3c681e5873",
            "0xAc45F7350c6fAcfa128A99D636430098e495dC79",
        ],
        [
            0xa11cen,
            "0x6b3eb4b70a36269b8079d0f74fc4ecb481083e25130c88c6be89aa4c7a3d92b6",
            "0xF3ab11810c3A5649F74008F5ef64D86B435f569b",
        ],
    ] as const)("matches the pinned vector for nsk %s", (nsk, privateKey, address) => {
        expect(deriveNameControllerKey(nsk)).toEqual({ privateKey, address });
    });

    it("is deterministic, and the address is the key's own", () => {
        const a = deriveNameControllerKey(42n);
        expect(deriveNameControllerKey(42n)).toEqual(a);
        expect(a.address).toBe(privateKeyToAddress(a.privateKey as `0x${string}`));
    });

    it("gives each account its own key, unrelated to the spending secret", () => {
        const keys = [1n, 2n, 3n].map((nsk) => deriveNameControllerKey(nsk));
        expect(new Set(keys.map((k) => k.privateKey)).size).toBe(3);
        expect(new Set(keys.map((k) => k.address)).size).toBe(3);
        expect(BigInt(keys[0]!.privateKey)).not.toBe(1n);
    });

    it("refuses a secret outside the field", () => {
        expect(() => deriveNameControllerKey(BN254_FR)).toThrow(InvalidArgumentError);
        expect(() => deriveNameControllerKey(-1n)).toThrow(InvalidArgumentError);
    });
});
