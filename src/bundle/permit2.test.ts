import { keccak256, recoverTypedDataAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { PrivateKeySigner } from "../chain/eth-signer.js";
import {
    type AuxOutput,
    computePiHash,
    type DepositIntent,
    PERMIT2_ADDRESS,
    signPermit2Witness,
} from "./permit2.js";

const PERMIT2_TYPES = {
    PermitWitnessTransferFrom: [
        { name: "permitted", type: "TokenPermissions" },
        { name: "spender", type: "address" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
        { name: "witness", type: "MASPDeposit" },
    ],
    TokenPermissions: [
        { name: "token", type: "address" },
        { name: "amount", type: "uint256" },
    ],
    MASPDeposit: [{ name: "piHash", type: "bytes32" }],
} as const;

const ANVIL_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;

describe("permit2", () => {
    it("signPermit2Witness round-trips: signature recovers the payer", async () => {
        const account = privateKeyToAccount(ANVIL_KEY);
        const chainId = 31337n;
        const signer = new PrivateKeySigner(ANVIL_KEY, "http://localhost:0", chainId);
        const spender = "0x0000000000000000000000000000000000005678";
        const token = "0x0000000000000000000000000000000000001234";
        const piHash = keccak256("0xdeadbeef");
        const nonce = 42n;
        const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
        const maxTotal = 1_000_000n;

        const out = await signPermit2Witness({
            signer,
            chainId,
            spender,
            token,
            maxTotal,
            nonce,
            deadline,
            piHash,
        });

        const recovered = await recoverTypedDataAddress({
            domain: { name: "Permit2", chainId, verifyingContract: PERMIT2_ADDRESS },
            types: PERMIT2_TYPES as any,
            primaryType: "PermitWitnessTransferFrom",
            message: {
                permitted: { token, amount: maxTotal },
                spender,
                nonce,
                deadline,
                witness: { piHash },
            },
            signature: out.signature as `0x${string}`,
        });
        expect(recovered.toLowerCase()).toBe(account.address.toLowerCase());
        expect(out.maxTotal).toBe(maxTotal);
        expect(out.nonce).toBe(nonce);
        expect(out.deadline).toBe(deadline);
    });

    it("computePiHash is deterministic + distinguishes inputs", () => {
        const intent: DepositIntent = {
            chainId: 31337n,
            publicAssetId: 1n,
            publicIn: 1000n,
            payer: "0x0000000000000000000000000000000000000001",
            recipient: "0x0000000000000000000000000000000000000002",
            outCm: [
                "0x0000000000000000000000000000000000000000000000000000000000000003",
                "0x0000000000000000000000000000000000000000000000000000000000000004",
            ],
            cvDep0: [11n, 12n],
            cvDep1: [13n, 14n],
            rcvTotal: 99n,
        };
        const aux: [AuxOutput, AuxOutput] = [
            {
                clueRx: 1n,
                clueRy: 2n,
                ephPubX: 3n,
                ephPubY: 4n,
                ciphertext: new Uint8Array([0xab, 0xcd, 0xef]),
            },
            {
                clueRx: 5n,
                clueRy: 6n,
                ephPubX: 7n,
                ephPubY: 8n,
                ciphertext: new Uint8Array([0x12, 0x34]),
            },
        ];
        const h1 = computePiHash(intent, aux);
        const h2 = computePiHash(intent, aux);
        expect(h1).toBe(h2);
        expect(h1).toMatch(/^0x[0-9a-f]{64}$/);

        const intent2 = { ...intent, publicIn: 1001n };
        expect(computePiHash(intent2, aux)).not.toBe(h1);
    });
});
