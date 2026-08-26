import { maspAbi } from "@lelantos-org/contracts";
import {
    concat,
    encodeAbiParameters,
    hashTypedData,
    keccak256,
    recoverTypedDataAddress,
    toBytes,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { PrivateKeySigner } from "../chain/eth-signer.js";
import { computePiHash } from "../protocol/abi-hash.js";
import {
    type AuxOutput,
    type DepositRequest,
    PERMIT2_ADDRESS,
    signPermit2Allowance,
    signPermit2AllowanceBatch,
    signPermit2Witness,
} from "./sign.js";

/**
 * The `PermitDetails` member list, as the tests state it independently of the
 * production table.
 *
 * Hoisted because it was written out four times in this file: the point of
 * restating it here rather than importing is that an unintended edit to
 * `PERMIT2_ALLOWANCE_TYPES` fails a test — four copies meant an edit could
 * match one and be missed by the others.
 */
const PERMIT_DETAILS = [
    { name: "token", type: "address" },
    { name: "amount", type: "uint160" },
    { name: "expiration", type: "uint48" },
    { name: "nonce", type: "uint48" },
] as const;

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
        const deposit: DepositRequest = {
            chainId: 31337n,
            publicAssetId: 1n,
            publicIn: 1000n,
            payer: "0x0000000000000000000000000000000000000001",
            recipient: "0x0000000000000000000000000000000000000002",
            outCm: "0x0000000000000000000000000000000000000000000000000000000000000003",
            cvDep: [11n, 12n],
            rcv: 99n,
            feeIn: 7n,
            feeCm: "0x0000000000000000000000000000000000000000000000000000000000000004",
            feeCvDep: [13n, 14n],
            feeRcv: 98n,
        };
        const aux: AuxOutput = {
            clueRx: 1n,
            clueRy: 2n,
            ephPubX: 3n,
            ephPubY: 4n,
            ciphertext: new Uint8Array([0xab, 0xcd, 0xef]),
        };
        const h1 = computePiHash(deposit, aux, aux);
        const h2 = computePiHash(deposit, aux, aux);
        expect(h1).toBe(h2);
        expect(h1).toMatch(/^0x[0-9a-f]{64}$/);

        const other = { ...deposit, publicIn: 1001n };
        expect(computePiHash(other, aux, aux)).not.toBe(h1);

        // The fee note is inside the witness too, so a relayer cannot swap in
        // a different one and reuse the payer's signature.
        const otherFee = { ...deposit, feeIn: 8n };
        expect(computePiHash(otherFee, aux, aux)).not.toBe(h1);
    });
});

describe("permit2 witness type string", () => {
    // The signing tests above re-declare the same type table and recover with
    // viem — which proves viem is self-consistent and nothing about the bytes
    // the contract verifies. These pin those bytes, so an edit to
    // `PERMIT2_TYPES` (a reordered field, a changed width, a renamed struct)
    // fails here rather than on chain.
    //
    // Permit2 builds the signed type string by concatenating its own stub with
    // the caller's witness type string, so this concatenation is what has to
    // equal `MASP._DEPOSIT_WITNESS_TYPE_STRING`.
    const WITNESS_TYPE_STRING =
        "PermitWitnessTransferFrom(TokenPermissions permitted,address spender,uint256 nonce," +
        "uint256 deadline,MASPDeposit witness)MASPDeposit(bytes32 piHash)" +
        "TokenPermissions(address token,uint256 amount)";

    const WITNESS_TYPEHASH = keccak256(toBytes(WITNESS_TYPE_STRING));
    const TOKEN_PERMISSIONS_TYPEHASH = keccak256(
        toBytes("TokenPermissions(address token,uint256 amount)"),
    );
    const MASP_DEPOSIT_TYPEHASH = keccak256(toBytes("MASPDeposit(bytes32 piHash)"));

    it("pins the typehashes the contract must agree with", () => {
        expect(WITNESS_TYPEHASH).toBe(
            "0x4fc8400d890c6f8cb526e53b865ce226717ac018bc6d2660ff9496a031c8fc1a",
        );
        expect(TOKEN_PERMISSIONS_TYPEHASH).toBe(
            "0x618358ac3db8dc274f0cd8829da7e234bd48cd73c4a740aede1adec9846d06a1",
        );
        expect(MASP_DEPOSIT_TYPEHASH).toBe(
            "0x8cfbfdbca8208f4e8028b3a50b2e83e8204f8fa08223df4eda5dacc99020ba19",
        );
    });

    it("produces the digest a hand-rolled EIP-712 encoding gives", () => {
        // The independent half: the struct hash is assembled here from the
        // type strings above, byte for byte as Solidity would, and compared
        // against what viem derives from the SDK's own `PERMIT2_TYPES`. They
        // agree only if that table encodes to exactly this type string — which
        // is the property the contract depends on and nothing else checked.
        const token = "0x0000000000000000000000000000000000001234" as const;
        const spender = "0x0000000000000000000000000000000000005678" as const;
        const amount = 1_000n;
        const nonce = 42n;
        const deadline = 1_700_000_000n;
        const piHash = keccak256("0xdeadbeef");

        const tokenPermissionsHash = keccak256(
            encodeAbiParameters(
                [{ type: "bytes32" }, { type: "address" }, { type: "uint256" }],
                [TOKEN_PERMISSIONS_TYPEHASH, token, amount],
            ),
        );
        const witnessHash = keccak256(
            encodeAbiParameters(
                [{ type: "bytes32" }, { type: "bytes32" }],
                [MASP_DEPOSIT_TYPEHASH, piHash],
            ),
        );
        const structHash = keccak256(
            encodeAbiParameters(
                [
                    { type: "bytes32" },
                    { type: "bytes32" },
                    { type: "address" },
                    { type: "uint256" },
                    { type: "uint256" },
                    { type: "bytes32" },
                ],
                [WITNESS_TYPEHASH, tokenPermissionsHash, spender, nonce, deadline, witnessHash],
            ),
        );

        const domain = {
            name: "Permit2",
            chainId: 31337,
            verifyingContract: PERMIT2_ADDRESS as `0x${string}`,
        };
        // Domain separator hand-rolled too. Permit2's domain omits `version`,
        // which is exactly the kind of detail a helper would paper over.
        const domainSeparator = keccak256(
            encodeAbiParameters(
                [
                    { type: "bytes32" },
                    { type: "bytes32" },
                    { type: "uint256" },
                    { type: "address" },
                ],
                [
                    keccak256(
                        toBytes(
                            "EIP712Domain(string name,uint256 chainId,address verifyingContract)",
                        ),
                    ),
                    keccak256(toBytes("Permit2")),
                    BigInt(domain.chainId),
                    domain.verifyingContract,
                ],
            ),
        );
        const expected = keccak256(concat(["0x1901", domainSeparator, structHash]));

        const viaSdkTable = hashTypedData({
            domain,
            types: PERMIT2_TYPES,
            primaryType: "PermitWitnessTransferFrom",
            message: {
                permitted: { token, amount },
                spender,
                nonce,
                deadline,
                witness: { piHash },
            },
        });

        expect(viaSdkTable).toBe(expected);
    });

    it("still finds the constants on the canonical MASP ABI", () => {
        // A rename on the contract side is the other way these drift. Read
        // from the published ABI, not the SDK's trimmed local copy.
        const names = maspAbi.filter((e) => e.type === "function").map((e) => e.name);
        expect(names).toContain("DEPOSIT_WITNESS_TYPE_STRING");
        expect(names).toContain("DEPOSIT_WITNESS_TYPEHASH");
    });
});

describe("signPermit2Allowance", () => {
    // The function casts its input through `as unknown as Record<string,
    // unknown>`, so a wrong uint48/uint160 width has no static check. These
    // cover it.
    const permit = {
        details: {
            token: `0x${"11".repeat(20)}` as `0x${string}`,
            amount: (1n << 160n) - 1n,
            expiration: 2 ** 48 - 1,
            nonce: 7,
        },
        spender: `0x${"22".repeat(20)}` as `0x${string}`,
        sigDeadline: 1_700_000_000n,
    };

    it("recovers to the signer over the AllowanceTransfer types", async () => {
        const account = privateKeyToAccount(ANVIL_KEY);
        const { signature } = await signPermit2Allowance({
            signer: new PrivateKeySigner(ANVIL_KEY, "http://localhost:0", 31337n),
            chainId: 31337n,
            permit,
        });

        const recovered = await recoverTypedDataAddress({
            domain: { name: "Permit2", chainId: 31337, verifyingContract: PERMIT2_ADDRESS },
            types: {
                PermitSingle: [
                    { name: "details", type: "PermitDetails" },
                    { name: "spender", type: "address" },
                    { name: "sigDeadline", type: "uint256" },
                ],
                PermitDetails: PERMIT_DETAILS,
            },
            primaryType: "PermitSingle",
            message: permit,
            signature: signature as `0x${string}`,
        });

        expect(recovered.toLowerCase()).toBe(account.address.toLowerCase());
    });

    it("rejects a value that overflows its declared width", async () => {
        // `uint160` and `uint48` are the widths the contract reads; viem
        // enforces them, which is the only thing standing between a silently
        // truncated allowance and a correct one.
        await expect(
            signPermit2Allowance({
                signer: new PrivateKeySigner(ANVIL_KEY, "http://localhost:0", 31337n),
                chainId: 31337n,
                permit: { ...permit, details: { ...permit.details, amount: 1n << 160n } },
            }),
        ).rejects.toThrow();
    });

    it("returns the permit it was given, unmodified", async () => {
        const { permit: out } = await signPermit2Allowance({
            signer: new PrivateKeySigner(ANVIL_KEY, "http://localhost:0", 31337n),
            chainId: 31337n,
            permit,
        });
        expect(out).toBe(permit);
    });
});

describe("signPermit2AllowanceBatch", () => {
    const BATCH_TYPES = {
        PermitBatch: [
            { name: "details", type: "PermitDetails[]" },
            { name: "spender", type: "address" },
            { name: "sigDeadline", type: "uint256" },
        ],
        PermitDetails: PERMIT_DETAILS,
    } as const;

    const spender = `0x${"22".repeat(20)}` as `0x${string}`;

    // Two entries with different nonces: Permit2 keys nonces by
    // `(owner, token, spender)`, so a batch that reused one value across
    // entries would verify here and revert `InvalidNonce` on chain.
    const permit = {
        details: [
            {
                token: `0x${"11".repeat(20)}` as `0x${string}`,
                amount: (1n << 160n) - 1n,
                expiration: 2 ** 48 - 1,
                nonce: 7,
            },
            {
                token: `0x${"33".repeat(20)}` as `0x${string}`,
                amount: 1_000_000n,
                expiration: 1_900_000_000,
                nonce: 0,
            },
        ],
        spender,
        sigDeadline: 1_700_000_000n,
    };

    const signerFor = () => new PrivateKeySigner(ANVIL_KEY, "http://localhost:0", 31337n);

    it("recovers to the signer over the PermitBatch types", async () => {
        const account = privateKeyToAccount(ANVIL_KEY);
        const { signature } = await signPermit2AllowanceBatch({
            signer: signerFor(),
            chainId: 31337n,
            permit,
        });

        const recovered = await recoverTypedDataAddress({
            domain: { name: "Permit2", chainId: 31337, verifyingContract: PERMIT2_ADDRESS },
            types: BATCH_TYPES,
            primaryType: "PermitBatch",
            message: permit,
            signature: signature as `0x${string}`,
        });

        expect(recovered.toLowerCase()).toBe(account.address.toLowerCase());
    });

    // The whole point of the batch: N entries, ONE signature that is not the
    // single-entry signature. A `PermitSingle` offered to the batch overload
    // (or vice versa) must not verify.
    it("does not collide with the PermitSingle signature for the same entry", async () => {
        const single = await signPermit2Allowance({
            signer: signerFor(),
            chainId: 31337n,
            permit: { details: permit.details[0]!, spender, sigDeadline: permit.sigDeadline },
        });
        const batch = await signPermit2AllowanceBatch({
            signer: signerFor(),
            chainId: 31337n,
            permit: { details: [permit.details[0]!], spender, sigDeadline: permit.sigDeadline },
        });
        expect(batch.signature).not.toBe(single.signature);
    });

    it("is order-sensitive", async () => {
        const a = await signPermit2AllowanceBatch({
            signer: signerFor(),
            chainId: 31337n,
            permit,
        });
        const b = await signPermit2AllowanceBatch({
            signer: signerFor(),
            chainId: 31337n,
            permit: { ...permit, details: [...permit.details].reverse() },
        });
        expect(a.signature).not.toBe(b.signature);
    });

    it("rejects a value that overflows its declared width", async () => {
        await expect(
            signPermit2AllowanceBatch({
                signer: signerFor(),
                chainId: 31337n,
                permit: {
                    ...permit,
                    details: [{ ...permit.details[0]!, amount: 1n << 160n }],
                },
            }),
        ).rejects.toThrow();
    });

    it("returns the permit it was given, unmodified", async () => {
        const { permit: out } = await signPermit2AllowanceBatch({
            signer: signerFor(),
            chainId: 31337n,
            permit,
        });
        expect(out).toBe(permit);
    });
});

// Same role as `describe("permit2 witness type string")` above: the tests
// there prove viem agrees with itself. These pin the bytes Permit2 actually
// hashes, so a reordered field or a changed width in
// `PERMIT2_ALLOWANCE_BATCH_TYPES` fails here rather than on chain as
// `InvalidSigner`.
describe("permit2 PermitBatch type string", () => {
    const PERMIT_DETAILS_TYPE_STRING =
        "PermitDetails(address token,uint160 amount,uint48 expiration,uint48 nonce)";
    const PERMIT_BATCH_TYPE_STRING =
        "PermitBatch(PermitDetails[] details,address spender,uint256 sigDeadline)" +
        PERMIT_DETAILS_TYPE_STRING;

    const PERMIT_DETAILS_TYPEHASH = keccak256(toBytes(PERMIT_DETAILS_TYPE_STRING));
    const PERMIT_BATCH_TYPEHASH = keccak256(toBytes(PERMIT_BATCH_TYPE_STRING));

    // Literals lifted from `PermitHash._PERMIT_DETAILS_TYPEHASH` and
    // `_PERMIT_BATCH_TYPEHASH` in the vendored Permit2.
    it("pins the typehashes Permit2 uses", () => {
        expect(PERMIT_DETAILS_TYPEHASH).toBe(
            "0x65626cad6cb96493bf6f5ebea28756c966f023ab9e8a83a7101849d5573b3678",
        );
        expect(PERMIT_BATCH_TYPEHASH).toBe(
            "0xaf1b0d30d2cab0380e68f0689007e3254993c596f2fdd0aaa7f4d04f79440863",
        );
    });

    // `PermitHash.hash(PermitBatch)` hashes the array member as
    // `keccak256(abi.encodePacked(perDetailHashes))`. Hand-rolling it here and
    // comparing against viem is what proves the `PermitDetails[]` member is
    // encoded the way the contract reads it.
    it("hand-rolled struct hash equals viem's hashTypedData", () => {
        const details = [
            {
                token: `0x${"11".repeat(20)}` as `0x${string}`,
                amount: 123_456n,
                expiration: 1_900_000_000,
                nonce: 7,
            },
            {
                token: `0x${"33".repeat(20)}` as `0x${string}`,
                amount: 1n,
                expiration: 1_800_000_000,
                nonce: 0,
            },
        ];
        const spender = `0x${"22".repeat(20)}` as `0x${string}`;
        const sigDeadline = 1_700_000_000n;

        const detailHashes = details.map((d) =>
            keccak256(
                encodeAbiParameters(
                    [
                        { type: "bytes32" },
                        { type: "address" },
                        { type: "uint160" },
                        { type: "uint48" },
                        { type: "uint48" },
                    ],
                    [PERMIT_DETAILS_TYPEHASH, d.token, d.amount, d.expiration, d.nonce],
                ),
            ),
        );
        const structHash = keccak256(
            encodeAbiParameters(
                [
                    { type: "bytes32" },
                    { type: "bytes32" },
                    { type: "address" },
                    { type: "uint256" },
                ],
                [PERMIT_BATCH_TYPEHASH, keccak256(concat(detailHashes)), spender, sigDeadline],
            ),
        );

        const domainSeparator = keccak256(
            encodeAbiParameters(
                [
                    { type: "bytes32" },
                    { type: "bytes32" },
                    { type: "uint256" },
                    { type: "address" },
                ],
                [
                    keccak256(
                        toBytes(
                            "EIP712Domain(string name,uint256 chainId,address verifyingContract)",
                        ),
                    ),
                    keccak256(toBytes("Permit2")),
                    31337n,
                    PERMIT2_ADDRESS as `0x${string}`,
                ],
            ),
        );
        const expected = keccak256(concat(["0x1901", domainSeparator, structHash]));

        const actual = hashTypedData({
            domain: { name: "Permit2", chainId: 31337, verifyingContract: PERMIT2_ADDRESS },
            types: {
                PermitBatch: [
                    { name: "details", type: "PermitDetails[]" },
                    { name: "spender", type: "address" },
                    { name: "sigDeadline", type: "uint256" },
                ],
                PermitDetails: PERMIT_DETAILS,
            },
            primaryType: "PermitBatch",
            message: { details, spender, sigDeadline },
        });

        expect(actual).toBe(expected);
    });
});
