// The JS fallback path.
//
// Isolated in its own file because `configurePoseidonWasm` installs a
// process-wide loader override and resets the module memo — a failing loader
// left behind would silently degrade every other suite in the same realm.
//
// Worth testing rather than assuming: a wallet that quietly loses the wasm
// backend is 2.5x slower with no other symptom, so both halves of the
// contract — that it still hashes correctly, and that it says so — matter.

import { poseidon5 } from "poseidon-lite/poseidon5";
import { afterEach, describe, expect, it } from "vitest";
import { configureLogging, type LogRecord } from "../log/logger.js";
import { Poseidon } from "./poseidon.js";
import { configurePoseidonWasm } from "./poseidon-wasm/loader.js";

function captureLogs(): LogRecord[] {
    const records: LogRecord[] = [];
    configureLogging({ level: "warn", sink: (r) => records.push(r), namespaces: null });
    return records;
}

afterEach(() => {
    configureLogging({ level: "silent" });
});

describe("wasm unavailable", () => {
    it("falls back to JS, still hashes correctly, and logs why", async () => {
        const records = captureLogs();
        configurePoseidonWasm({
            loadModule: () => Promise.reject(new Error("no wasm here")),
        });

        const P = await Poseidon.build();

        expect(P.backend).toBe("js");

        // Correctness is not optional on the degraded path.
        const xs = [1n, 2n, 3n, 4n, 5n];
        expect(P.hash(xs)).toBe(poseidon5(xs));

        // And the reason has to reach the operator, or a 2.5x regression looks
        // like "sync is slow today".
        const warned = records.find((r) => r.ns === "lelantos:crypto:poseidon");
        expect(warned?.level).toBe("warn");
        expect(warned?.fields?.error).toContain("no wasm here");
    });
});
