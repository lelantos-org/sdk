import { maspAbi, nativeAdapterAbi } from "@lelantos-org/contracts";
import { toEventSignature, toFunctionSignature } from "viem";
import { describe, expect, it } from "vitest";
import { MASP_ABI, NATIVE_ADAPTER_ABI } from "./abi.js";

// `abi.ts` is hand-maintained, so it can drift from the deployed contracts
// silently — a wrong tuple shape encodes a call that reverts, or worse, one
// that succeeds against the wrong slot. `@lelantos-org/contracts` ships the
// Foundry-generated ABI, so the two can be compared.
//
// A devDependency, not a runtime one: importing `maspAbi` into the bundle
// would cost ~27 KB minified for a 30 KB constant that cannot be shaken
// per-entry, against a ~6 KB hand-maintained subset. The canonical ABI is
// worth having at build time and not at runtime.

type AbiParam = { type: string; components?: readonly AbiParam[] };
type AbiItem = { type: string; name?: string; outputs?: readonly AbiParam[] };

const sigOf = (i: AbiItem): string =>
    i.type === "event"
        ? toEventSignature(i as Parameters<typeof toEventSignature>[0])
        : toFunctionSignature(i as Parameters<typeof toFunctionSignature>[0]);

/**
 * Return types, rendered like an input signature.
 *
 * `toFunctionSignature` covers inputs only — it is the selector, and outputs
 * are not part of it. That is not enough here: `asset` and `escrowed` agree on
 * their selector while disagreeing on what they return, and a wrong return
 * shape decodes to the wrong fields rather than reverting. Names are dropped;
 * only the type structure is binding.
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

/** Inputs and outputs together — the whole calling contract for one entry. */
const fingerprint = (i: AbiItem): string => `${sigOf(i)} -> ${outputsOf(i)}`;

/**
 * Entries that do not match the deployed contract, enumerated rather than
 * skipped wholesale. Anything here is a live incompatibility, not a style
 * difference.
 *
 * `yieldState` is the SDK running ahead of the published contracts package:
 * the yield mixin is not in `@lelantos-org/contracts@0.5.0`, so there is
 * nothing to compare the entry against yet. `reads.fetchAssetYield` is written
 * for exactly that — a pool without the selector reverts and reads as "no
 * yield" — so the SDK is correct against both shapes meanwhile. Drop this once
 * the package ships the mixin; the test below then fails until it is removed.
 */
const PENDING_MIGRATION = new Set<string>(["function:yieldState"]);

/**
 * The pool and the native bridge are separate deployments, so each
 * hand-written subset is checked against its own canonical ABI. A native
 * entry compared against `maspAbi` would report as merely absent, which
 * reads like a rename rather than the address change it is.
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
        // Guards the guard: a new hand-written entry must be compared, not
        // silently uncovered, and a stale exemption must be removed once the
        // entry agrees again.
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
