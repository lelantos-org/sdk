import { describe, it, expect } from "vitest";
import { Wallet, verifyTypedData, getAddress } from "ethers";
import { signErc2612Permit } from "./permit";

const PERMIT_TYPES = {
    Permit: [
        { name: "owner", type: "address" },
        { name: "spender", type: "address" },
        { name: "value", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
    ],
} as const;

describe("signErc2612Permit", () => {
    it("round-trips: signature recovers the payer's address", async () => {
        const signer = new Wallet("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
        const token = "0x0000000000000000000000000000000000001234";
        const spender = "0x0000000000000000000000000000000000005678";
        const chainId = 31337n;
        const value = 1_000_000n;
        const nonce = 0n;
        const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);

        const out = await signErc2612Permit({
            signer, token, tokenName: "USDC", chainId,
            spender, value, nonce, deadline,
        });

        // Reassemble the 65-byte sig and verify.
        const sigHex = out.r + out.s.slice(2) + out.v.toString(16).padStart(2, "0");
        const recovered = verifyTypedData(
            { name: "USDC", version: "1", chainId, verifyingContract: token },
            PERMIT_TYPES,
            { owner: signer.address, spender, value, nonce, deadline },
            sigHex,
        );
        expect(getAddress(recovered)).toBe(getAddress(signer.address));
        expect(out.value).toBe(value.toString());
        expect(out.deadline).toBe(Number(deadline));
        expect(out.r).toMatch(/^0x[0-9a-f]{64}$/);
        expect(out.s).toMatch(/^0x[0-9a-f]{64}$/);
    });

    it("custom version is honored in the domain", async () => {
        const signer = new Wallet("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
        const token = "0x000000000000000000000000000000000000ABCD";
        const out = await signErc2612Permit({
            signer, token, tokenName: "DAI", tokenVersion: "2", chainId: 1n,
            spender: "0x000000000000000000000000000000000000DEAD",
            value: 1n, nonce: 0n, deadline: 1n,
        });
        const sigHex = out.r + out.s.slice(2) + out.v.toString(16).padStart(2, "0");
        const recovered = verifyTypedData(
            { name: "DAI", version: "2", chainId: 1n, verifyingContract: token },
            PERMIT_TYPES,
            {
                owner: signer.address,
                spender: "0x000000000000000000000000000000000000DEAD",
                value: 1n, nonce: 0n, deadline: 1n,
            },
            sigHex,
        );
        expect(getAddress(recovered)).toBe(getAddress(signer.address));
    });
});
