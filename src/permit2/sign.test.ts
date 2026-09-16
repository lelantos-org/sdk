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
import { PrivateKeySigner } from "../chain/signer/private-key.js";
import { isWalletError } from "../errors/guard.js";
import type { EthSigner } from "../keys/signer.js";
import { computePiHash } from "../protocol/abi-hash.js";
import {
    type AuxOutput,
    type DepositRequest,
    PERMIT2_ADDRESS,
} from "../protocol/deposit-request.js";
import { signPermit2Allowance, signPermit2AllowanceBatch } from "./allowance.js";
import { signPermit2Witness } from "./witness.js";

/**
 * The `PermitDetails` member list, restated independently of the production
 * table so an unintended edit to `PERMIT2_ALLOWANCE_TYPES` fails a test.
 * Defined once for all tests in this file.
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
            feeAssetId: 1n,
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

        // The fee note is part of the witness, so a relayer cannot substitute
        // a different one and reuse the payer's signature.
        const otherFee = { ...deposit, feeIn: 8n };
        expect(computePiHash(otherFee, aux, aux)).not.toBe(h1);

        // So is its asset: a submitter cannot move the charge onto another
        // token the payer holds.
        const otherFeeAsset = { ...deposit, feeAssetId: 2n };
        expect(computePiHash(otherFeeAsset, aux, aux)).not.toBe(h1);
    });
});

describe("permit2 witness type string", () => {
    // The signing tests above recover with viem, which checks only viem's
    // self-consistency. These pin the bytes the contract verifies, so an edit to
    // `PERMIT2_TYPES` (reordered field, changed width, renamed struct) fails
    // here rather than on chain.
    //
    // Permit2 builds the signed type string by concatenating its own stub with
    // the caller's witness type string; this concatenation must equal
    // `MASP._DEPOSIT_WITNESS_TYPE_STRING`.
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
        // The struct hash is assembled from the type strings above as Solidity
        // would, and compared against viem's digest from `PERMIT2_TYPES`. They
        // agree only if that table encodes to exactly this type string, which
        // is the property the contract depends on.
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
        // Domain separator also built manually, since Permit2's domain omits
        // `version`.
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
        // Guards against a contract-side rename. Reads the published ABI, not
        // the SDK's trimmed local copy.
        const names = maspAbi.filter((e) => e.type === "function").map((e) => e.name);
        expect(names).toContain("DEPOSIT_WITNESS_TYPE_STRING");
        expect(names).toContain("DEPOSIT_WITNESS_TYPEHASH");
    });
});

// ─── two-token witness permit ────────────────────────────────────────────────
//
// A relayer note in another asset is pulled under a
// `PermitBatchWitnessTransferFrom` over `[deposit token, fee token]`. The vector
// is lifted from a forge trace of
// `MASPDepositFeeAssetTest.test_signature_crossAsset_pullsBothTokens`
// (`forge test --match-test test_signature_crossAsset_pullsBothTokens -vvvv`):
// the request and payloads MASP received, the digest `_batchDigest` handed to
// `vm.sign`, and the signature Permit2 then accepted.

describe("signPermit2Witness batch form", () => {
    const FORGE = {
        chainId: 31337n,
        spender: "0xa0Cb889707d426A7A386870A03bc70d1b0697598",
        token: "0x5615dEB798BB3E4dFa0139dFa1b3D433Cc23b72f",
        maxTotal: 10_025_000_000_000n,
        feeToken: "0x15cF58144EF33af1e14b5208015d11F9143E27b9",
        maxFee: 70_000n,
        nonce: 0n,
        deadline: (1n << 256n) - 1n,
        /** `keccak256(abi.encode(DEPOSIT_WITNESS_TYPEHASH, piHash))`, from the Permit2 call. */
        witness: "0x15668c4ea4cb4f9c7e1e1fa0ef692e53323c91221e541bfe23112ddb3cf67f95",
        domainSeparator: "0xd5a17abc3865df5c1400c0299bd4ce2eefc8114aec5f9d3dded1745783e57b98",
        /**
         * The `verifyingContract` behind that separator. `DeployPermit2` etches
         * prebuilt bytecode at the canonical address, and Permit2 caches its
         * domain at construction, so forge signs under the address it was built
         * at rather than the canonical one. Passed as `permit2Address`, the
         * override for exactly such a non-canonical domain.
         */
        verifyingContract: "0xF62849F9A0B5Bf2913b396098F7c7019b51A820a",
        digest: "0x236cc2c0229beef15f0a55475e59b525ebb96e06f65767c892e49923b525e97a",
        /** `SIGNER_PK = 0x5161E7`. */
        key: `0x${"5161e7".padStart(64, "0")}` as const,
        signature:
            "0xff43473e64cea04848d6809fb7cb96456e1de92f513f4121f7f0885f150902a9" +
            "13b40488d3cbdda35ace0b9a4dbe76f54ae3f4929846ff5af0e521bb374817131c",
    } as const;

    /** `SpendFixture.validAux()[0]`, used for both payloads in that test. */
    const forgeAux: AuxOutput = {
        clueRx: 5299619240641551281634865583518297030282874472190772894086521144482721001553n,
        clueRy: 16950150798460657717958625567821834550301663161624707787222815936182638968203n,
        ephPubX: 5299619240641551281634865583518297030282874472190772894086521144482721001553n,
        ephPubY: 16950150798460657717958625567821834550301663161624707787222815936182638968203n,
        ciphertext: new Uint8Array([0x00, 0x01]),
    };
    const forgeRequest: DepositRequest = {
        chainId: 31337n,
        publicAssetId: 1n,
        publicIn: 1000n,
        payer: "0x5F3cAc19f89bd2e972062Db0F287c525E1913341",
        recipient: "0x000000000000000000000000000000000000F00D",
        outCm: `0x${"100".padStart(64, "0")}`,
        cvDep: [192n, 193n],
        rcv: 0n,
        feeAssetId: 2n,
        feeIn: 7n,
        feeCm: `0x${"101".padStart(64, "0")}`,
        feeCvDep: [240n, 241n],
        feeRcv: 0n,
    };
    const piHash = computePiHash(forgeRequest, forgeAux, forgeAux);

    /**
     * A signer that records the typed data it is asked to sign, and signs it
     * with `inner` when given.
     */
    function recordingSigner(inner?: EthSigner) {
        const calls: Parameters<EthSigner["signTypedData"]>[] = [];
        const signer = {
            signTypedData: async (...args: Parameters<EthSigner["signTypedData"]>) => {
                calls.push(args);
                return inner ? inner.signTypedData(...args) : "0x";
            },
        } as unknown as EthSigner;
        return { signer, calls };
    }

    /** The EIP-712 digest of a recorded `signTypedData` call. */
    const digestOf = ([domain, types, primaryType, message]: Parameters<
        EthSigner["signTypedData"]
    >) => hashTypedData({ domain, types, primaryType, message } as never);

    const batchArgs = (signer: EthSigner) => ({
        signer,
        chainId: FORGE.chainId,
        spender: FORGE.spender,
        token: FORGE.token,
        maxTotal: FORGE.maxTotal,
        feeToken: FORGE.feeToken,
        maxFee: FORGE.maxFee,
        nonce: FORGE.nonce,
        deadline: FORGE.deadline,
        piHash,
        permit2Address: FORGE.verifyingContract,
    });

    it("hashes the request to the piHash the forge witness was built from", () => {
        expect(
            keccak256(
                encodeAbiParameters(
                    [{ type: "bytes32" }, { type: "bytes32" }],
                    [keccak256(toBytes("MASPDeposit(bytes32 piHash)")), piHash],
                ),
            ),
        ).toBe(FORGE.witness);
    });

    it("signs forge's `_batchDigest`, reproducing the signature Permit2 accepted", async () => {
        const { signer, calls } = recordingSigner(
            new PrivateKeySigner(FORGE.key, "http://localhost:0", FORGE.chainId),
        );
        const out = await signPermit2Witness(batchArgs(signer));

        expect(calls).toHaveLength(1);
        expect(calls[0]![2]).toBe("PermitBatchWitnessTransferFrom");
        // The vector also pins the entry order, `[token, feeToken]`.
        expect(digestOf(calls[0]!)).toBe(FORGE.digest);
        expect(out).toEqual({
            nonce: FORGE.nonce,
            deadline: FORGE.deadline,
            maxTotal: FORGE.maxTotal,
            maxFee: FORGE.maxFee,
            signature: FORGE.signature,
        });
    });

    it("hand-rolled batch digest equals forge's, from the Permit2 type string", () => {
        // `_batchDigest`, transliterated: Permit2's batch stub followed by the
        // witness type string MASP passes, an array member hashed as the packed
        // entry hashes, and Permit2's version-less domain.
        const tpType = keccak256(toBytes("TokenPermissions(address token,uint256 amount)"));
        const entry = (token: `0x${string}`, amount: bigint) =>
            keccak256(
                encodeAbiParameters(
                    [{ type: "bytes32" }, { type: "address" }, { type: "uint256" }],
                    [tpType, token, amount],
                ),
            );
        const typeHash = keccak256(
            toBytes(
                "PermitBatchWitnessTransferFrom(TokenPermissions[] permitted,address spender,uint256 nonce,uint256 deadline," +
                    "MASPDeposit witness)MASPDeposit(bytes32 piHash)TokenPermissions(address token,uint256 amount)",
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
                [
                    typeHash,
                    keccak256(
                        concat([
                            entry(FORGE.token, FORGE.maxTotal),
                            entry(FORGE.feeToken, FORGE.maxFee),
                        ]),
                    ),
                    FORGE.spender,
                    FORGE.nonce,
                    FORGE.deadline,
                    FORGE.witness,
                ],
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
                    FORGE.chainId,
                    FORGE.verifyingContract,
                ],
            ),
        );
        expect(domainSeparator).toBe(FORGE.domainSeparator);
        expect(keccak256(concat(["0x1901", domainSeparator, structHash]))).toBe(FORGE.digest);
    });

    it("keeps the single-token form, with maxFee 0, when no fee token is given", async () => {
        const { signer, calls } = recordingSigner();
        const { feeToken: _t, maxFee: _f, ...single } = batchArgs(signer);
        const out = await signPermit2Witness(single);

        // Exactly the pre-existing single-token typed data, restated from the
        // independent `PERMIT2_TYPES` above.
        expect(digestOf(calls[0]!)).toBe(
            hashTypedData({
                domain: {
                    name: "Permit2",
                    chainId: FORGE.chainId,
                    verifyingContract: FORGE.verifyingContract,
                },
                types: PERMIT2_TYPES,
                primaryType: "PermitWitnessTransferFrom",
                message: {
                    permitted: { token: FORGE.token, amount: FORGE.maxTotal },
                    spender: FORGE.spender,
                    nonce: FORGE.nonce,
                    deadline: FORGE.deadline,
                    witness: { piHash },
                },
            }),
        );
        // The pool reverts `BadMaxFee` for anything else on this path.
        expect(out.maxFee).toBe(0n);
    });

    it("refuses a fee token without its ceiling, and the reverse", async () => {
        const { signer, calls } = recordingSigner();
        const { maxFee: _f, ...noMax } = batchArgs(signer);
        const { feeToken: _t, ...noToken } = batchArgs(signer);
        for (const [args, argument] of [
            [noMax, "maxFee"],
            [noToken, "feeToken"],
        ] as const) {
            const err = await signPermit2Witness(args).catch((e: unknown) => e);
            expect(isWalletError(err, "INVALID_ARGUMENT")).toBe(true);
            expect((err as { argument?: string }).argument).toBe(argument);
        }
        expect(calls).toHaveLength(0);
    });
});

describe("signPermit2Allowance", () => {
    // The function casts its input through `as unknown as Record<string,
    // unknown>`, so uint48/uint160 widths have no static check.
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
        // `uint160` and `uint48` are the widths the contract reads; viem's
        // enforcement is the only guard against a truncated allowance.
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

describe("allowance type tables on the EIP-1193 wire", () => {
    // `Eip1193Signer` serialises the tables verbatim, so pin their JSON, key order included.
    const captureTypes = async (sign: (signer: EthSigner) => Promise<unknown>) => {
        let types: unknown;
        const signer = {
            signTypedData: async (_d: unknown, t: unknown) => {
                types = t;
                return "0x";
            },
        } as unknown as EthSigner;
        await sign(signer);
        return JSON.stringify(types);
    };
    const DETAILS =
        '"PermitDetails":[{"name":"token","type":"address"},{"name":"amount","type":"uint160"},' +
        '{"name":"expiration","type":"uint48"},{"name":"nonce","type":"uint48"}]';
    const details = { token: `0x${"11".repeat(20)}`, amount: 1n, expiration: 1, nonce: 0 };

    it("PermitSingle", async () => {
        const json = await captureTypes((signer) =>
            signPermit2Allowance({
                signer,
                chainId: 1n,
                permit: { details, spender: `0x${"22".repeat(20)}`, sigDeadline: 1n },
            }),
        );
        expect(json).toBe(
            '{"PermitSingle":[{"name":"details","type":"PermitDetails"},' +
                '{"name":"spender","type":"address"},{"name":"sigDeadline","type":"uint256"}],' +
                `${DETAILS}}`,
        );
    });

    it("PermitBatch", async () => {
        const json = await captureTypes((signer) =>
            signPermit2AllowanceBatch({
                signer,
                chainId: 1n,
                permit: { details: [details], spender: `0x${"22".repeat(20)}`, sigDeadline: 1n },
            }),
        );
        expect(json).toBe(
            '{"PermitBatch":[{"name":"details","type":"PermitDetails[]"},' +
                '{"name":"spender","type":"address"},{"name":"sigDeadline","type":"uint256"}],' +
                `${DETAILS}}`,
        );
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
    // `(owner, token, spender)`, so reusing one value across entries would
    // verify here but revert `InvalidNonce` on chain.
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

    // A batch is N entries under one signature distinct from the single-entry
    // signature. A `PermitSingle` offered to the batch overload (or vice versa)
    // must not verify.
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

// Same role as `describe("permit2 witness type string")` above: pins the bytes
// Permit2 hashes, so a reordered field or changed width in
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

    // Literals taken from `PermitHash._PERMIT_DETAILS_TYPEHASH` and
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
    // `keccak256(abi.encodePacked(perDetailHashes))`. Building it manually and
    // comparing against viem checks that the `PermitDetails[]` member is
    // encoded as the contract reads it.
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
