import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { deriveEphemeralKey, hostPayerIndex } from "./ephemeral.js";

const NSK = 0x2a3f0c91b7de4415a8c6f0e2d9b7314c5f80a1263e94d7b0c18f5a627d3e0491bn % (1n << 251n);
const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

describe("deriveEphemeralKey", () => {
    it("is deterministic", () => {
        expect(deriveEphemeralKey(NSK, 0)).toBe(deriveEphemeralKey(NSK, 0));
    });

    it("golden vector — a change here strands funds at old addresses", () => {
        // Pins the derivation (domain tag and byte layout). Any change makes
        // existing funded ephemeral addresses unreachable.
        expect(deriveEphemeralKey(1n, 0)).toBe(
            "0x2095110998e29c5ea5116f6d44471639e36d8c3576cb5760b71bccba57af675b",
        );
        // A multi-byte index pins the little-endian `u32` suffix.
        expect(deriveEphemeralKey(0x1234567n, 0x01020304)).toBe(
            "0x64ca20a81d38cda5b09cbb8d3dc181e7a78eadb47085a30efb9665bc2db7ae91",
        );
    });

    it("separates indices", () => {
        const keys = [0, 1, 2, 7, 1000].map((i) => deriveEphemeralKey(NSK, i));
        expect(new Set(keys).size).toBe(keys.length);
    });

    it("separates wallets", () => {
        expect(deriveEphemeralKey(NSK, 0)).not.toBe(deriveEphemeralKey(NSK + 1n, 0));
    });

    it("yields a valid secp256k1 scalar", () => {
        for (const i of [0, 1, 42, 0x7fffffff]) {
            const scalar = BigInt(deriveEphemeralKey(NSK, i));
            expect(scalar).toBeGreaterThan(0n);
            expect(scalar).toBeLessThan(SECP256K1_N);
        }
    });

    it("produces a usable viem account", () => {
        const account = privateKeyToAccount(deriveEphemeralKey(NSK, 3));
        expect(account.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    });

    it("rejects out-of-range indices", () => {
        expect(() => deriveEphemeralKey(NSK, -1)).toThrow(/integer in \[0, 2\^31\)/);
        expect(() => deriveEphemeralKey(NSK, 2 ** 31)).toThrow(/integer in \[0, 2\^31\)/);
        expect(() => deriveEphemeralKey(NSK, 1.5)).toThrow(/integer in \[0, 2\^31\)/);
    });
});

describe("hostPayerIndex", () => {
    it("gives each host its own payer address", () => {
        // A shared slot gives every server the same publicly funded `from`
        // address, letting servers link payments to one wallet.
        const addr = (host: string) =>
            privateKeyToAccount(deriveEphemeralKey(NSK, hostPayerIndex(host))).address;

        const hosts = ["api.one.example", "api.two.example", "three.example"];
        expect(new Set(hosts.map(addr)).size).toBe(hosts.length);
    });

    it("is stable across calls and case-insensitive, so a top-up survives a restart", () => {
        expect(hostPayerIndex("API.Example")).toBe(hostPayerIndex("api.example"));
    });

    it("stays inside the derivation's index range", () => {
        for (const host of ["a", "api.example", "x".repeat(200)]) {
            const i = hostPayerIndex(host);
            expect(Number.isInteger(i)).toBe(true);
            expect(i).toBeGreaterThanOrEqual(0);
            expect(i).toBeLessThan(2 ** 31);
        }
    });
});
