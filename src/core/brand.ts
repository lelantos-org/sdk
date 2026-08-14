// Nominal types for the values callers most often confuse.
//
// The SDK's API surface is dominated by two structural types: `string` for
// four different address and hash formats, and `bigint` for asset ids plus
// three separate amount spaces. Structurally they are interchangeable, so
// transposing them compiles and fails at runtime — or, worse, succeeds
// against the wrong recipient. Branding makes each one nominal.
//
// Brands are erased at runtime: a `CircuitAmount` is a `bigint`, an
// `EvmAddress` is a string, and arithmetic or interpolation works unchanged.
// JavaScript consumers are unaffected.
//
// Each constructor validates and brands. Values that come back out of the SDK
// are already branded, so a normal flow — `wallet.asset(...)` into
// `parseAmount` into `wallet.transfer` — needs no calls here at all.

import { InvalidArgumentError } from "./errors.js";

declare const BRAND: unique symbol;

/**
 * Nominal wrapper: structurally `T`, but assignable only from a value carrying
 * the same tag.
 */
export type Brand<T, Tag extends string> = T & { readonly [BRAND]: Tag };

/** 20-byte EVM address, `0x`-prefixed and checksum-agnostic. */
export type EvmAddress = Brand<`0x${string}`, "EvmAddress">;

/** 32-byte value as `0x`-prefixed hex: commitments, nullifiers, tx hashes. */
export type Hex32 = Brand<`0x${string}`, "Hex32">;

/** bech32m shielded payment address (`sswap21…`). */
export type ShieldedAddress = Brand<`sswap21${string}`, "ShieldedAddress">;

/** MASP registry asset id (`uint64`). */
export type AssetId = Brand<bigint, "AssetId">;

/** Amount in circuit units — the denomination every `Wallet` method takes. */
export type CircuitAmount = Brand<bigint, "CircuitAmount">;

/** Amount in ERC-20 base units: `token = circuit * asset.scale`. */
export type TokenAmount = Brand<bigint, "TokenAmount">;

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HEX_32 = /^0x[0-9a-fA-F]{64}$/;
// bech32m: HRP `sswap2`, separator `1`, then the charset minus `1bio`.
const SHIELDED = /^sswap21[02-9ac-hj-np-z]+$/;
const U64_MAX = (1n << 64n) - 1n;

/**
 * Validate and brand a 20-byte EVM address.
 *
 * @throws {InvalidArgumentError} on anything that is not `0x` + 40 hex digits.
 */
export function evmAddress(value: string): EvmAddress {
    if (!EVM_ADDRESS.test(value)) {
        throw new InvalidArgumentError(
            `not a 20-byte 0x-prefixed EVM address: ${JSON.stringify(value)}`,
            { argument: "address" },
        );
    }
    return value as EvmAddress;
}

/**
 * Validate and brand a 32-byte hex value.
 *
 * @throws {InvalidArgumentError} on anything that is not `0x` + 64 hex digits.
 */
export function hex32(value: string): Hex32 {
    if (!HEX_32.test(value)) {
        throw new InvalidArgumentError(
            `not a 32-byte 0x-prefixed hex value: ${JSON.stringify(value)}`,
            { argument: "hex32" },
        );
    }
    return value as Hex32;
}

/**
 * Validate and brand a shielded address.
 *
 * Checks the HRP and the bech32m charset only. `decodeAddress` performs the
 * checksum and curve checks when the payload is actually needed.
 *
 * @throws {InvalidArgumentError} when the string is not a well-formed
 * `sswap21…` bech32m address.
 */
export function shieldedAddress(value: string): ShieldedAddress {
    if (!SHIELDED.test(value)) {
        throw new InvalidArgumentError(
            `not a bech32m shielded address (expected \`sswap21…\`): ${JSON.stringify(value)}`,
            { argument: "address" },
        );
    }
    return value as ShieldedAddress;
}

/**
 * Validate and brand a MASP asset id.
 *
 * @throws {InvalidArgumentError} when negative or beyond `uint64`.
 */
export function assetId(value: bigint | number): AssetId {
    const id = BigInt(value);
    if (id < 0n || id > U64_MAX) {
        throw new InvalidArgumentError(`asset id out of uint64 range: ${id}`, {
            argument: "asset",
        });
    }
    return id as AssetId;
}

/**
 * Brand a circuit-unit amount. Prefer `parseAmount(value, asset)`, which
 * derives it from a human decimal string.
 *
 * @throws {InvalidArgumentError} when negative.
 */
export function circuitAmount(value: bigint): CircuitAmount {
    if (value < 0n) {
        throw new InvalidArgumentError(`amount must not be negative: ${value}`, {
            argument: "amount",
        });
    }
    return value as CircuitAmount;
}

/**
 * Brand an ERC-20 base-unit amount. Prefer `toTokenUnits`, which converts from
 * circuit units.
 *
 * @throws {InvalidArgumentError} when negative.
 */
export function tokenAmount(value: bigint): TokenAmount {
    if (value < 0n) {
        throw new InvalidArgumentError(`amount must not be negative: ${value}`, {
            argument: "amount",
        });
    }
    return value as TokenAmount;
}

/**
 * Apply a brand without validating. For SDK-internal use where the value's
 * provenance already guarantees the invariant: a freshly formatted hex word, a
 * wire field a decoder has just checked, the result of arithmetic on values
 * that were themselves branded.
 *
 * The overloads tie each brand to its base primitive, so
 * `branded<CircuitAmount>("0x…")` does not compile.
 *
 * @internal
 */
export function branded<B extends Brand<string, string>>(value: string): B;
export function branded<B extends Brand<bigint, string>>(value: bigint): B;
export function branded(value: string | bigint): unknown {
    return value;
}
