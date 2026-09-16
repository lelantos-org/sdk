// The JS fallback path.
//
// Isolated in its own file because `configurePoseidonWasm` installs a process-wide loader override
// and resets the module memo; a failing loader would degrade every other suite in the same realm.
//
// Losing the wasm backend makes hashing 2.5x slower with no other symptom, so the fallback must
// both hash correctly and log a warning.

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

        // The fallback must produce identical digests.
        const xs = [1n, 2n, 3n, 4n, 5n];
        expect(P.hash(xs)).toBe(poseidon5(xs));

        // The reason must reach the operator, or the slowdown looks like an ordinary slow sync.
        const warned = records.find((r) => r.ns === "lelantos:crypto:poseidon");
        expect(warned?.level).toBe("warn");
        expect(warned?.fields?.error).toContain("no wasm here");
    });
});
