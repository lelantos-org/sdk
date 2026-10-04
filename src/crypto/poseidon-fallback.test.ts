// The JS fallback path. In its own file because `configurePoseidonWasm` installs a process-wide
// loader override and resets the module memo; a failing loader would degrade every other suite in
// the same realm.

import { poseidon1 } from "poseidon-lite/poseidon1";
import { poseidon2 } from "poseidon-lite/poseidon2";
import { poseidon3 } from "poseidon-lite/poseidon3";
import { poseidon4 } from "poseidon-lite/poseidon4";
import { poseidon5 } from "poseidon-lite/poseidon5";
import { poseidon6 } from "poseidon-lite/poseidon6";
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

        // The fallback must produce identical digests, each arity from its own table.
        const tables = [poseidon1, poseidon2, poseidon3, poseidon4, poseidon5, poseidon6];
        for (const [i, table] of tables.entries()) {
            const xs = Array.from({ length: i + 1 }, (_, k) => BigInt(k + 1));
            expect(P.hash(xs)).toBe(table(xs));
        }
        expect(() => P.hash([])).toThrow(/not supported/);
        expect(() => P.hash(Array.from({ length: 7 }, () => 1n))).toThrow(/not supported/);

        // The reason must reach the operator, or the slowdown looks like an ordinary slow sync.
        const warned = records.find((r) => r.ns === "lelantos:crypto:poseidon");
        expect(warned?.level).toBe("warn");
        expect(warned?.fields?.error).toContain("no wasm here");
    });
});
