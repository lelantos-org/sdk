// Naming an asset without knowing its MASP id.
//
// The pool addresses assets by a `uint64` id, which is the one thing a caller
// almost never has to hand: they have a symbol from a UI, or a token address
// from a config. Every consumer therefore built the same lookup — webapp-ui's
// `registered-assets.ts` is that layer, written because the SDK had none — so
// it lives here instead.
//
// Resolution is syntactic, not a search across every field:
//
//   0x…    an ERC-20 address (case-insensitive; EIP-55 is not required)
//   digits a decimal MASP asset id
//   else   a token symbol (case-insensitive)
//
// Ordering matters and is the reason the rules are syntactic. A symbol may be
// all digits in principle, and an address is a valid hex integer, so a "try
// each in turn" resolver would answer differently depending on what happened
// to be registered. These rules answer the same way whatever the registry
// holds; an unmatched ref is an error, never a different asset.

import { type AssetId, type AssetIdLike, assetId } from "../core/brand.js";
import { InvalidArgumentError } from "../core/errors.js";
import type { AssetInfo } from "./assets.js";

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
 * A `0x` string that is not 20 bytes is rejected here rather than falling
 * through to a symbol lookup: it is a mistyped address, and reporting it as an
 * unknown symbol sends the reader hunting in the wrong place.
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
 * `undefined` when nothing matches — the caller decides whether that is worth
 * a fetch or an error, since an id may be resolvable from the chain even when
 * it is absent from a relayer-supplied list.
 *
 * @throws {InvalidArgumentError} when a symbol matches more than one asset.
 * Two tokens may legitimately share a symbol, and picking either would send
 * funds to whichever happened to be registered first.
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
