// Nominal types for values that are structurally interchangeable (address and
// hash strings; asset ids and amounts as `bigint`), so transposing two of them
// is a compile error rather than a payment to the wrong recipient.
//
// Brands are erased at runtime: a `CircuitAmount` is a `bigint`, an
// `EvmAddress` is a string. Each constructor validates and brands; values
// returned by the SDK are already branded.

import { InvalidArgumentError } from "../errors/config.js";

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

/** bech32m shielded payment address (`lelantos1…`). */
export type ShieldedAddress = Brand<`lelantos1${string}`, "ShieldedAddress">;

/**
 * bech32m viewing key: `lelantosivk1…` (incoming) or `lelantosfvk1…` (full).
 * One brand covers both tiers; the decoded value's shape carries the tier.
 */
export type ViewingKeyString = Brand<
    `lelantosivk1${string}` | `lelantosfvk1${string}`,
    "ViewingKeyString"
>;

/** MASP registry asset id (`uint64`). */
export type AssetId = Brand<bigint, "AssetId">;

/**
 * Accepted wherever an asset id is an input: a plain `bigint` is branded on the
 * way in. Outputs stay `AssetId`.
 */
export type AssetIdLike = AssetId | bigint;

/**
 * Accepted wherever a shielded address is an input. `decodeAddress` validates
 * the string regardless of branding.
 */
export type ShieldedAddressLike = ShieldedAddress | string;

/** Accepted wherever an EVM address is an input. */
export type EvmAddressLike = EvmAddress | `0x${string}`;

/**
 * Accepted wherever a circuit-unit amount is an input. Use `parseAmount` to
 * convert a human string to circuit units.
 */
export type CircuitAmountLike = CircuitAmount | bigint;

/** Amount in circuit units, the denomination every wallet method takes. */
export type CircuitAmount = Brand<bigint, "CircuitAmount">;

/** Amount in ERC-20 base units: `token = circuit * asset.scale`. */
export type TokenAmount = Brand<bigint, "TokenAmount">;

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HEX_32 = /^0x[0-9a-fA-F]{64}$/;
// bech32m: HRP `lelantos`, separator `1`, then the charset minus `1bio`.
const SHIELDED = /^lelantos1[02-9ac-hj-np-z]+$/;
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

/** Whether `value` is `0x` and 64 hex digits. */
export function isHex32(value: unknown): value is Hex32 {
    return typeof value === "string" && HEX_32.test(value);
}

/**
 * Validate and brand a 32-byte hex value.
 *
 * @throws {InvalidArgumentError} on anything that is not `0x` + 64 hex digits.
 */
export function hex32(value: string): Hex32 {
    if (!isHex32(value)) {
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
 * Checks the HRP and the bech32m charset only; `decodeAddress` performs the
 * checksum and curve checks.
 *
 * @throws {InvalidArgumentError} when the string is not a well-formed
 * `lelantos1…` bech32m address.
 */
export function shieldedAddress(value: string): ShieldedAddress {
    if (!SHIELDED.test(value)) {
        throw new InvalidArgumentError(
            // The address is kept out of the message: error text reaches application logs, and
            // an address identifies a payee.
            "not a bech32m shielded address (expected `lelantos1…`)",
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
    return nonNegativeAmount(value) as CircuitAmount;
}

/**
 * Brand an ERC-20 base-unit amount. Prefer `toTokenUnits`, which converts from
 * circuit units.
 *
 * @throws {InvalidArgumentError} when negative.
 */
export function tokenAmount(value: bigint): TokenAmount {
    return nonNegativeAmount(value) as TokenAmount;
}

function nonNegativeAmount(value: bigint): bigint {
    if (value < 0n) {
        throw new InvalidArgumentError(`amount must not be negative: ${value}`, {
            argument: "amount",
        });
    }
    return value;
}

/**
 * Apply a brand without validating, where the value's provenance guarantees
 * the invariant: a freshly formatted hex word, a wire field a decoder has
 * checked, or arithmetic on branded values.
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
