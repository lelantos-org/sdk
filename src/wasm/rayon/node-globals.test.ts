import { afterEach, describe, expect, it } from "vitest";
import { installWorkerGlobals, withWorkerGlobals } from "./node-globals.js";

// Regression: the previous polyfill installed `self`, `addEventListener`,
// `removeEventListener` and `postMessage` on globalThis and never removed
// them. After the WASM prover loaded once, the Node main thread answered
// yes to the conventional worker-context check —
//   typeof self !== "undefined" && typeof postMessage === "function"
// — for the rest of the process, for every library in it.

const KEYS = ["self", "addEventListener", "removeEventListener", "postMessage"] as const;

function snapshot() {
    const g = globalThis as Record<string, unknown>;
    return Object.fromEntries(KEYS.map((k) => [k, k in g ? g[k] : Symbol.for("absent")]));
}

const before = snapshot();

afterEach(() => {
    const g = globalThis as Record<string, unknown>;
    for (const k of KEYS) {
        if (before[k] === Symbol.for("absent")) delete g[k];
        else g[k] = before[k];
    }
});

describe("installWorkerGlobals", () => {
    it("installs the stubs and removes exactly them on restore", () => {
        const g = globalThis as Record<string, unknown>;
        const handle = installWorkerGlobals();

        expect(typeof g.self).toBe("object");
        expect(typeof g.postMessage).toBe("function");
        expect(typeof g.addEventListener).toBe("function");

        handle.restore();

        for (const k of KEYS) {
            expect(k in g, `${k} should be gone after restore`).toBe(false);
        }
    });

    it("leaves host-provided values alone", () => {
        const g = globalThis as Record<string, unknown>;
        const hostPostMessage = () => "host";
        g.postMessage = hostPostMessage;

        const handle = installWorkerGlobals();
        expect(g.postMessage).toBe(hostPostMessage);
        handle.restore();
        // Not ours to delete.
        expect(g.postMessage).toBe(hostPostMessage);
    });

    it("is idempotent on restore", () => {
        const handle = installWorkerGlobals();
        handle.restore();
        expect(() => handle.restore()).not.toThrow();
    });
});

describe("withWorkerGlobals", () => {
    it("exposes the stubs to the callback and cleans up after", async () => {
        const g = globalThis as Record<string, unknown>;
        const seen = await withWorkerGlobals(async () => typeof g.postMessage);
        expect(seen).toBe("function");
        expect("postMessage" in g).toBe(false);
    });

    it("restores even when the callback throws", async () => {
        const g = globalThis as Record<string, unknown>;
        await expect(
            withWorkerGlobals(async () => {
                throw new Error("wasm load failed");
            }),
        ).rejects.toThrow("wasm load failed");
        expect("postMessage" in g).toBe(false);
    });
});
