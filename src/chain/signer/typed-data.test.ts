// The SDK has two EIP-712 paths, and they must agree.
//
// `PrivateKeySigner` hands the structured `{domain, types, primaryType,
// message}` to viem, which hashes it. `Eip1193Signer` cannot: a raw provider
// wants JSON for `eth_signTypedData_v4`, with an explicit `EIP712Domain` entry
// and every integer as a hex string. The helpers here do that conversion by
// hand, so nothing viem does covers them.
//
// A divergence is silent and expensive. The same wallet would derive a
// different `nsk` depending on which signer built the payload, and a Permit2
// witness signed through a browser wallet would recover to the wrong address
// on chain — the deposit reverts, having already cost a proof.
//
// These tests hash both ways and require the same digest. The wire payload is
// round-tripped through `JSON.parse(JSON.stringify(...))` first, because that
// is what actually reaches the provider, and read back the way a wallet reads
// it: hex strings widen to integers for integer-typed fields.

import { hashTypedData, type TypedDataDomain, type TypedDataParameter } from "viem";
import { describe, expect, it } from "vitest";
import { domainTypes, serialisableDomain, stringifyBigInts } from "./typed-data.js";

type Types = Record<string, TypedDataParameter[]>;

/** The Permit2 witness, the payload where a mismatch costs an on-chain revert. */
const PERMIT2_DOMAIN: TypedDataDomain = {
    name: "Permit2",
    chainId: 31337n,
    verifyingContract: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
};

const PERMIT2_TYPES: Types = {
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
};

const PERMIT2_MESSAGE = {
    permitted: { token: "0x0000000000000000000000000000000000000001", amount: 1000n },
    spender: "0x0000000000000000000000000000000000000002",
    nonce: 7n,
    deadline: 1893456000n,
    witness: { piHash: `0x${"ab".repeat(32)}` },
};

/** Exactly what `Eip1193Signer` puts on the wire, after a JSON round trip. */
function wirePayload(domain: TypedDataDomain, types: Types, primaryType: string, message: object) {
    return JSON.parse(
        JSON.stringify({
            types: { EIP712Domain: domainTypes(domain), ...types },
            primaryType,
            domain: serialisableDomain(domain),
            message: stringifyBigInts(message),
        }),
    );
}

/** How a wallet reads the payload back: hex strings widen to integers. */
function parseAsWallet(value: any, typeName: string, types: Types): unknown {
    const struct = types[typeName];
    if (struct) {
        const out: Record<string, unknown> = {};
        for (const field of struct)
            out[field.name] = parseAsWallet(value[field.name], field.type, types);
        return out;
    }
    const isInteger = /^u?int\d*$/.test(typeName);
    return isInteger && typeof value === "string" ? BigInt(value) : value;
}

/**
 * Hash the wire payload the way a wallet would, so it can be compared to
 * viem's.
 *
 * The domain separator is built from the *declared* `EIP712Domain` entries,
 * not from whatever keys the domain object happens to carry — that is what a
 * provider does, and it is the difference that makes a declaration drifting
 * out of step with the values a hash mismatch rather than a silent no-op.
 */
function hashWire(payload: any, primaryType: string): string {
    const { EIP712Domain: declared, ...types } = payload.types;
    const domain: Record<string, unknown> = {};
    for (const field of declared as TypedDataParameter[]) {
        const raw = payload.domain[field.name];
        domain[field.name] = /^u?int\d*$/.test(field.type) ? BigInt(raw) : raw;
    }
    return hashTypedData({
        domain,
        types,
        primaryType,
        message: parseAsWallet(payload.message, primaryType, types) as Record<string, unknown>,
    });
}

describe("eth_signTypedData_v4 serialisation", () => {
    it("hashes to the same digest as viem's structured path", () => {
        const payload = wirePayload(
            PERMIT2_DOMAIN,
            PERMIT2_TYPES,
            "PermitWitnessTransferFrom",
            PERMIT2_MESSAGE,
        );
        expect(hashWire(payload, "PermitWitnessTransferFrom")).toBe(
            hashTypedData({
                domain: PERMIT2_DOMAIN,
                types: PERMIT2_TYPES,
                primaryType: "PermitWitnessTransferFrom",
                message: PERMIT2_MESSAGE,
            }),
        );
    });

    it("agrees for the AllowanceTransfer shape, whose ints are narrower", () => {
        // uint160 / uint48 exercise the same hex path at other widths; a
        // serialiser that padded to the declared width would break here.
        const types: Types = {
            PermitSingle: [
                { name: "details", type: "PermitDetails" },
                { name: "spender", type: "address" },
                { name: "sigDeadline", type: "uint256" },
            ],
            PermitDetails: [
                { name: "token", type: "address" },
                { name: "amount", type: "uint160" },
                { name: "expiration", type: "uint48" },
                { name: "nonce", type: "uint48" },
            ],
        };
        const message = {
            details: {
                token: "0x0000000000000000000000000000000000000003",
                amount: 2n ** 159n,
                expiration: 1893456000n,
                nonce: 0n,
            },
            spender: "0x0000000000000000000000000000000000000004",
            sigDeadline: 1893456000n,
        };
        const payload = wirePayload(PERMIT2_DOMAIN, types, "PermitSingle", message);
        expect(hashWire(payload, "PermitSingle")).toBe(
            hashTypedData({
                domain: PERMIT2_DOMAIN,
                types,
                primaryType: "PermitSingle",
                message,
            }),
        );
    });

    it("declares EIP712Domain to match the fields it actually sends", () => {
        // The provider derives the domain separator from this list, so an
        // entry present in one and absent from the other shifts the hash.
        const payload = wirePayload(PERMIT2_DOMAIN, PERMIT2_TYPES, "PermitWitnessTransferFrom", {});
        expect(payload.types.EIP712Domain.map((f: TypedDataParameter) => f.name)).toEqual(
            Object.keys(payload.domain),
        );
    });

    it("omits absent domain fields rather than sending them undefined", () => {
        // `salt` is unused by every domain the SDK builds. Emitting it as
        // `null` would add it to the separator.
        const payload = wirePayload(PERMIT2_DOMAIN, PERMIT2_TYPES, "PermitWitnessTransferFrom", {});
        expect(Object.keys(payload.domain)).toEqual(["name", "chainId", "verifyingContract"]);
        expect(payload.types.EIP712Domain).not.toContainEqual({ name: "salt", type: "bytes32" });
    });

    it("encodes every integer as hex, at any nesting depth", () => {
        const payload = wirePayload(
            PERMIT2_DOMAIN,
            PERMIT2_TYPES,
            "PermitWitnessTransferFrom",
            PERMIT2_MESSAGE,
        );
        expect(payload.domain.chainId).toBe("0x7a69");
        expect(payload.message.nonce).toBe("0x07");
        expect(payload.message.permitted.amount).toBe("0x03e8");
        expect(payload.message.witness.piHash).toBe(`0x${"ab".repeat(32)}`);
    });
});
