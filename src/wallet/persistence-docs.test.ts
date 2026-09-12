// The persistence backends documented on `TreePersistence` and
// `NullifierPersistence` must run.
//
// Both state types carry `bigint[]`, which `JSON.stringify` rejects. This pins
// the encode/decode their JSDoc shows.

import { describe, expect, it } from "vitest";
import type { NullifierPersistence, NullifierStoreState } from "./nullifier-store.js";
import type { TreePersistence, TreeStoreState } from "./tree-store.js";

/** A JSON string store, standing in for `localStorage`. */
function memoryStore() {
    const cells = new Map<string, string>();
    return {
        getItem: (k: string) => cells.get(k) ?? null,
        setItem: (k: string, v: string) => void cells.set(k, v),
        removeItem: (k: string) => void cells.delete(k),
    };
}

describe("documented JSON persistence backends", () => {
    it("plain JSON.stringify throws on a tree state", () => {
        const state: TreeStoreState = { leaves: [1n, 2n], syncedCount: 2 };
        expect(() => JSON.stringify(state)).toThrow(TypeError);
    });

    it("the documented TreePersistence round-trips", async () => {
        const store = memoryStore();

        // Verbatim shape of the `@example` on `TreePersistence`.
        const persistence: TreePersistence = {
            async load() {
                const raw = store.getItem("tree");
                if (raw === null) return null;
                const { leaves, syncedCount } = JSON.parse(raw) as {
                    leaves: string[];
                    syncedCount: number;
                };
                return { leaves: leaves.map(BigInt), syncedCount };
            },
            async save(state: TreeStoreState) {
                store.setItem(
                    "tree",
                    JSON.stringify({
                        leaves: state.leaves.map((v) => `0x${v.toString(16)}`),
                        syncedCount: state.syncedCount,
                    }),
                );
            },
            async clear() {
                store.removeItem("tree");
            },
        };

        expect(await persistence.load()).toBeNull();

        // A leaf whose hex digits are all decimal: the case the `0x` prefix
        // exists for. Without it, `BigInt("10")` reads 10, not 16.
        const state: TreeStoreState = { leaves: [16n, 0n, 2n ** 200n], syncedCount: 3 };
        await persistence.save(state);
        expect(await persistence.load()).toEqual(state);

        await persistence.clear();
        expect(await persistence.load()).toBeNull();
    });

    it("the same encoding round-trips a nullifier state", async () => {
        const store = memoryStore();
        const persistence: NullifierPersistence = {
            async load() {
                const raw = store.getItem("nf");
                if (raw === null) return null;
                const { nullifiers, syncedCount } = JSON.parse(raw) as {
                    nullifiers: string[];
                    syncedCount: number;
                };
                return { nullifiers: nullifiers.map(BigInt), syncedCount };
            },
            async save(state: NullifierStoreState) {
                store.setItem(
                    "nf",
                    JSON.stringify({
                        nullifiers: state.nullifiers.map((v) => `0x${v.toString(16)}`),
                        syncedCount: state.syncedCount,
                    }),
                );
            },
        };

        const state: NullifierStoreState = { nullifiers: [16n, 255n], syncedCount: 2 };
        await persistence.save(state);
        expect(await persistence.load()).toEqual(state);
    });
});
