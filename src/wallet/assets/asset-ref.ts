// Naming an asset without its MASP id.
//
// The pool addresses assets by a `uint64` id, while callers typically hold a
// symbol from a UI or a token address from a config.
//
// Resolution is syntactic, not a search across every field:
//
//   0x…    an ERC-20 address (case-insensitive; EIP-55 is not required)
//   digits a decimal MASP asset id
//   else   a token symbol (case-insensitive)
//
// A symbol may be all digits and an address is a valid hex integer, so a
// resolver that tries each field in turn would depend on registry contents.
// Syntactic rules give the same classification for any registry; an unmatched
// ref is an error, never a different asset.

import { type AssetId, type AssetIdLike, assetId } from "../../core/brand.js";
import { assertNever } from "../../errors/base.js";
import { InvalidArgumentError } from "../../errors/config.js";
import type { AssetInfo } from "./info.js";

/**
 * How a caller names an asset: its MASP id, its ERC-20 address, or its symbol.
 *
 * `1n` / `"1"` are the id; `"0x…"` is the token; anything else is a symbol.
 */
export type AssetRef = AssetIdLike | string;

/** Which kind of name a ref is, decided before any registry is consulted. */
export type RefKind =
    | { kind: "id"; id: AssetId }
    | { kind: "token"; token: string }
    | { kind: "symbol"; symbol: string };

const DECIMAL = /^\d+$/;
const HEX_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HEX_PREFIX = /^0x/i;

/**
 * Classify `ref` without needing a registry.
 *
 * A `0x` string that is not 20 bytes is rejected as a malformed address instead
 * of falling through to a symbol lookup, which would report a misleading error.
 */
export function classifyRef(ref: AssetRef): RefKind {
    if (typeof ref === "bigint") return { kind: "id", id: assetId(ref) };

    const text = ref.trim();
    if (text === "") {
        throw new InvalidArgumentError("asset reference is empty", { argument: "asset" });
    }
    if (HEX_PREFIX.test(text)) {
        if (!HEX_ADDRESS.test(text)) {
            throw new InvalidArgumentError(
                `asset reference ${JSON.stringify(ref)} looks like a token address but is not ` +
                    "a 20-byte 0x-prefixed value",
                { argument: "asset" },
            );
        }
        return { kind: "token", token: text.toLowerCase() };
    }
    if (DECIMAL.test(text)) return { kind: "id", id: assetId(BigInt(text)) };
    return { kind: "symbol", symbol: text.toLowerCase() };
}

/**
 * Find the one asset in `known` that `ref` names.
 *
 * Returns `undefined` when nothing matches; the caller decides between a fetch
 * and an error, since an id absent from a relayer-supplied list may still be
 * resolvable from the chain.
 *
 * @throws {InvalidArgumentError} when a symbol matches more than one asset.
 * Two tokens may share a symbol, and picking either could send funds to the
 * wrong one.
 */
export function matchRef(known: readonly AssetInfo[], ref: AssetRef): AssetInfo | undefined {
    const want = classifyRef(ref);
    switch (want.kind) {
        case "id":
            return known.find((a) => a.id === want.id);
        case "token":
            return known.find((a) => a.token.toLowerCase() === want.token);
        case "symbol": {
            const hits = known.filter((a) => a.symbol?.toLowerCase() === want.symbol);
            if (hits.length > 1) {
                throw new InvalidArgumentError(
                    `asset symbol ${JSON.stringify(ref)} is ambiguous: it matches ids ` +
                        `${hits.map((a) => a.id).join(", ")}. Name it by id or token address.`,
                    { argument: "asset" },
                );
            }
            return hits[0];
        }
    }
    // Without this, an unhandled variant would return `undefined` and read as "no match".
    return assertNever(want, "asset ref kind");
}

/** Human description of a ref, for error messages. */
export function describeRef(ref: AssetRef): string {
    const want = classifyRef(ref);
    switch (want.kind) {
        case "id":
            return `asset id ${want.id}`;
        case "token":
            return `token ${want.token}`;
        case "symbol":
            return `symbol ${JSON.stringify(String(ref).trim())}`;
    }
}
