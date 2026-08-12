import { maspAbi } from "@lelantos-org/contracts";
import { toEventSignature, toFunctionSignature } from "viem";
import { describe, expect, it } from "vitest";
import { MASP_ABI } from "./abi.js";

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

const canonical = new Map(
    (maspAbi as readonly AbiItem[])
        .filter((i) => i.type === "function" || i.type === "event")
        .map((i) => [`${i.type}:${i.name}`, i]),
);

/** Inputs and outputs together — the whole calling contract for one entry. */
const fingerprint = (i: AbiItem): string => `${sigOf(i)} -> ${outputsOf(i)}`;

/**
 * Entries that do not match the deployed contract, enumerated rather than
 * skipped wholesale. Empty: the SDK now speaks the one-output deposit intent.
 * Anything added here is a live incompatibility, not a style difference.
 */
const PENDING_MIGRATION = new Set<string>([]);

const items = MASP_ABI as readonly AbiItem[];

describe("MASP_ABI vs the canonical contracts ABI", () => {
    const checked = items.filter((i) => !PENDING_MIGRATION.has(`${i.type}:${i.name}`));

    it.each(
        checked.map((i) => [`${i.type}:${i.name}`, i] as const),
    )("%s matches the deployed contract", (key, item) => {
        const ref = canonical.get(key);
        expect(ref, `${key} is absent from the canonical ABI`).toBeDefined();
        expect(fingerprint(item)).toBe(fingerprint(ref as AbiItem));
    });

    it("covers every entry that is not explicitly pending migration", () => {
        // Guards the guard: a new hand-written entry must be compared, not
        // silently uncovered, and a stale exemption must be removed once the
        // entry agrees again.
        expect(checked.length + PENDING_MIGRATION.size).toBe(items.length);

        for (const key of PENDING_MIGRATION) {
            const item = items.find((i) => `${i.type}:${i.name}` === key);
            expect(item, `${key} is exempted but no longer present in MASP_ABI`).toBeDefined();
            const ref = canonical.get(key);
            if (ref) {
                expect(
                    fingerprint(item as AbiItem),
                    `${key} now matches the canonical ABI — drop it from PENDING_MIGRATION`,
                ).not.toBe(fingerprint(ref));
            }
        }
    });
});
