import { maspAbi, nativeAdapterAbi } from "@lelantos-org/contracts";
import { toEventSelector, toEventSignature, toFunctionSelector, toFunctionSignature } from "viem";
import { describe, expect, it } from "vitest";
import { MASP_ABI, NATIVE_ADAPTER_ABI } from "./abi.js";

// `abi.ts` is hand-maintained and can drift from the deployed contracts
// silently: a wrong tuple shape encodes a call that reverts, or one that
// succeeds against the wrong slot. `@lelantos-org/contracts`, a devDependency,
// ships the Foundry-generated ABI to compare against.

type AbiParam = { type: string; components?: readonly AbiParam[] };
type AbiItem = { type: string; name?: string; outputs?: readonly AbiParam[] };

const sigOf = (i: AbiItem): string =>
    i.type === "event"
        ? toEventSignature(i as Parameters<typeof toEventSignature>[0])
        : toFunctionSignature(i as Parameters<typeof toFunctionSignature>[0]);

/**
 * Return types, rendered like an input signature, names dropped.
 *
 * `toFunctionSignature` covers inputs only, so an entry such as `asset` or
 * `escrowed` can match its canonical selector while disagreeing on the return
 * type, and a wrong return shape decodes to the wrong fields rather than
 * reverting.
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
 * Entries exempt from the comparison because `@lelantos-org/contracts` has not
 * yet published the contract change behind them. May be empty. The second test
 * below fails once an exempted entry matches, forcing its removal.
 */
const PENDING_MIGRATION = new Set<string>();

/**
 * The pool and the native bridge are separate deployments, so each subset is
 * checked against its own canonical ABI.
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
        // Every entry is either compared or exempted, and an exemption is
        // removed once its entry matches.
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

// The relayer pins the same selectors (`backend` relayer `adapters/abi.rs`).
// Each follows the `DepositRequest`, `Permit2Sig` and `FeeNote` layouts, so a
// copy that drifts from the contracts fails here rather than on chain. The
// literals are `cast sig` / `cast sig-event` over the contracts' signatures.
describe("deposit selectors", () => {
    const selectorOf = (name: string, abi: readonly AbiItem[] = MASP_ABI as readonly AbiItem[]) => {
        const item = abi.find((i) => i.type === "function" && i.name === name);
        return toFunctionSelector(item as Parameters<typeof toFunctionSelector>[0]);
    };

    it.each([
        ["deposit", "0x8969b932"],
        ["depositAuthorized", "0x4778b347"],
        ["cancelDeposit", "0xc4e85ddc"],
    ])("%s is %s", (name, selector) => {
        expect(selectorOf(name)).toBe(selector);
    });

    it("cancelNative, on the adapter, is 0xa15198c3", () => {
        expect(selectorOf("cancelNative", NATIVE_ADAPTER_ABI as readonly AbiItem[])).toBe(
            "0xa15198c3",
        );
    });

    // A deposit reads its escrow off the receipt by this topic and a cancel by
    // id queries logs by it, so a wrong one finds no escrow at all.
    it("DepositEscrowed is topic 0x48786aa9…", () => {
        const item = (MASP_ABI as readonly AbiItem[]).find(
            (i) => i.type === "event" && i.name === "DepositEscrowed",
        );
        expect(toEventSelector(item as Parameters<typeof toEventSelector>[0])).toBe(
            "0x48786aa9d3678601a40c373a6118f7b062456414dee7cf289e46a81059fcbe57",
        );
    });
});
