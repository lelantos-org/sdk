import { maspAbi, nativeAdapterAbi } from "@lelantos-org/contracts";
import { toEventSignature, toFunctionSelector, toFunctionSignature } from "viem";
import { describe, expect, it } from "vitest";
import { MASP_ABI, NATIVE_ADAPTER_ABI } from "./abi.js";

// `abi.ts` is hand-maintained and can drift from the deployed contracts
// silently: a wrong tuple shape encodes a call that reverts, or one that
// succeeds against the wrong slot. `@lelantos-org/contracts` ships the
// Foundry-generated ABI to compare against.
//
// It is a devDependency, not a runtime one: importing `maspAbi` into the bundle
// would cost ~27 KB minified for a 30 KB constant that cannot be shaken
// per entry, against a ~6 KB hand-maintained subset.

type AbiParam = { type: string; components?: readonly AbiParam[] };
type AbiItem = { type: string; name?: string; outputs?: readonly AbiParam[] };

const sigOf = (i: AbiItem): string =>
    i.type === "event"
        ? toEventSignature(i as Parameters<typeof toEventSignature>[0])
        : toFunctionSignature(i as Parameters<typeof toFunctionSignature>[0]);

/**
 * Return types, rendered like an input signature.
 *
 * `toFunctionSignature` covers inputs only, since outputs are not part of the
 * selector. An entry such as `asset` or `escrowed` can match its canonical
 * selector while disagreeing on the return type, and a wrong return shape
 * decodes to the wrong fields rather than reverting. Names are dropped; only
 * the type structure is binding.
 */
const outputsOf = (i: AbiItem): string => {
    const render = (p: AbiParam): string =>
        p.components
            ? `(${p.components.map(render).join(",")})${p.type.slice("tuple".length)}`
            : p.type;
    return `(${(i.outputs ?? []).map(render).join(",")})`;
};

const indexBy = (abi: readonly AbiItem[]) =>
    new Map(
        abi
            .filter((i) => i.type === "function" || i.type === "event")
            .map((i) => [`${i.type}:${i.name}`, i]),
    );

/** Inputs and outputs together: the full calling contract for one entry. */
const fingerprint = (i: AbiItem): string => `${sigOf(i)} -> ${outputsOf(i)}`;

/**
 * Entries that do not match the deployed contract, enumerated rather than
 * skipped wholesale. Anything here is a live incompatibility, not a style
 * difference.
 *
 * May be empty. The SDK can add a read before `@lelantos-org/contracts`
 * publishes the contract change behind it; such an entry is listed here until
 * then. The second test below fails once an exempted entry matches, forcing its
 * removal.
 */
const PENDING_MIGRATION = new Set<string>();

/**
 * The pool and the native bridge are separate deployments, so each
 * hand-written subset is checked against its own canonical ABI. A native
 * entry compared against `maspAbi` would report as absent, which reads like a
 * rename rather than a different contract address.
 */
const SUBSETS = [
    { name: "MASP_ABI", items: MASP_ABI as readonly AbiItem[], canonical: maspAbi },
    {
        name: "NATIVE_ADAPTER_ABI",
        items: NATIVE_ADAPTER_ABI as readonly AbiItem[],
        canonical: nativeAdapterAbi,
    },
] as const;

describe.each(SUBSETS)("$name vs the canonical contracts ABI", ({ items, canonical: ref }) => {
    const canonical = indexBy(ref as readonly AbiItem[]);
    const checked = items.filter((i) => !PENDING_MIGRATION.has(`${i.type}:${i.name}`));

    it.each(
        checked.map((i) => [`${i.type}:${i.name}`, i] as const),
    )("%s matches the deployed contract", (key, item) => {
        const found = canonical.get(key);
        expect(found, `${key} is absent from the canonical ABI`).toBeDefined();
        expect(fingerprint(item)).toBe(fingerprint(found as AbiItem));
    });

    it("covers every entry that is not explicitly pending migration", () => {
        // A new hand-written entry must be compared, not silently uncovered,
        // and a stale exemption must be removed once the entry matches.
        const exempted = items.filter((i) => PENDING_MIGRATION.has(`${i.type}:${i.name}`));
        expect(checked.length + exempted.length).toBe(items.length);

        for (const item of exempted) {
            const key = `${item.type}:${item.name}`;
            const found = canonical.get(key);
            if (found) {
                expect(
                    fingerprint(item),
                    `${key} now matches the canonical ABI — drop it from PENDING_MIGRATION`,
                ).not.toBe(fingerprint(found));
            }
        }
    });
});

// The relayer pins the same selectors (`backend` relayer `adapters/abi.rs`), and
// HANDOFF-listed values from the Foundry build. A deposit struct that gains a
// field (here `feeAssetId`, `Permit2Sig.maxFee`, `FeeNote.feeAssetId`) moves
// all three, so a stale copy on either side fails here rather than on chain.
describe("deposit selectors", () => {
    const selectorOf = (name: string) => {
        const item = (MASP_ABI as readonly AbiItem[]).find(
            (i) => i.type === "function" && i.name === name,
        );
        return toFunctionSelector(item as Parameters<typeof toFunctionSelector>[0]);
    };

    it.each([
        ["deposit", "0xfee3714c"],
        ["depositAuthorized", "0xdf1daf3b"],
        ["cancelDeposit", "0x5a0083a7"],
    ])("%s is %s", (name, selector) => {
        expect(selectorOf(name)).toBe(selector);
    });
});
