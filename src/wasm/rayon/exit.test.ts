import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const run = promisify(execFile);

// Rayon workers park in `Atomics.wait` inside wasm and each hold a live
// MessagePort, so without `unref()` any Node process that touches the WASM
// prover never exits on its own.
//
// The assertion is that the event loop drains, which cannot be observed from
// inside the process under test — vitest's own loop is not it — so this runs
// in a child process.
//
// It also runs against `dist/`, because the behaviour depends on real
// `node:worker_threads` semantics: a MessagePort re-refs when a "message"
// listener is attached, which is why `unref()` must come after `on()`. A fake
// worker would not catch a change there.

const DIST = fileURLToPath(new URL("../../../dist/prover/wasm-prover.js", import.meta.url));
const built = existsSync(DIST);

describe.skipIf(!built)("rayon pool does not pin the Node event loop", () => {
    it("a process that preloads the WASM prover exits on its own", async () => {
        const script = `
            const { WasmProver } = await import(${JSON.stringify(DIST)});
            await WasmProver.preload();
            // No process.exit(): the assertion is that the loop drains.
        `;
        const started = Date.now();
        const { stdout } = await run(process.execPath, ["--input-type=module", "-e", script], {
            timeout: 45_000,
            encoding: "utf8",
        });
        // execFile rejects on timeout or non-zero exit, so reaching here is
        // the assertion. Keep a generous bound; the pool starts in ~50ms.
        expect(Date.now() - started).toBeLessThan(45_000);
        expect(stdout).toBe("");
    }, 60_000);

    it("refuses to rebuild after a shutdown instead of hanging", async () => {
        // rayon's global pool is initialised once per wasm module instance,
        // and the module cannot be replaced: a re-import returns the same
        // instance from the runtime's module registry, with the same linear
        // memory and the same now-dead pool registered in it. A second
        // `initThreadPool` throws and falls back to single-threaded, but the
        // fallback does not help — the module still dispatches into the dead
        // pool, so `prove` blocks on a latch nothing will ever signal.
        //
        // Without the guard, prove → shutdown → prove hangs indefinitely. A
        // throw is the available outcome; proving again requires a fresh
        // realm.
        const script = `
            const { WasmProver } = await import(${JSON.stringify(DIST)});
            const { rayonWorkerCount } = await import(
                ${JSON.stringify(fileURLToPath(new URL("../../../dist/wasm/rayon/index.js", import.meta.url)))}
            );
            await WasmProver.preload();
            const first = rayonWorkerCount();
            await WasmProver.shutdown();
            let message = null;
            try {
                await WasmProver.preload();
            } catch (e) {
                message = e.message;
            }
            console.log(JSON.stringify({ first, down: rayonWorkerCount(), message }));
        `;
        const { stdout } = await run(process.execPath, ["--input-type=module", "-e", script], {
            timeout: 45_000,
            encoding: "utf8",
        });
        const out = JSON.parse(stdout.trim());

        expect(out.first).toBeGreaterThan(0);
        expect(out.down).toBe(0);
        expect(out.message).toMatch(/fresh worker or process/);
    }, 60_000);

    it("shutdown() terminates the workers and restores globalThis.Worker", async () => {
        const script = `
            const { WasmProver } = await import(${JSON.stringify(DIST)});
            const { rayonWorkerCount } = await import(
                ${JSON.stringify(fileURLToPath(new URL("../../../dist/wasm/rayon/index.js", import.meta.url)))}
            );
            await WasmProver.preload();
            const before = rayonWorkerCount();
            await WasmProver.shutdown();
            console.log(JSON.stringify({
                before,
                after: rayonWorkerCount(),
                worker: typeof globalThis.Worker,
                self: typeof globalThis.self,
            }));
        `;
        const { stdout } = await run(process.execPath, ["--input-type=module", "-e", script], {
            timeout: 45_000,
            encoding: "utf8",
        });
        const out = JSON.parse(stdout.trim());

        expect(out.before).toBeGreaterThan(0);
        expect(out.after).toBe(0);
        expect(out.worker).toBe("undefined");
        // The worker-shaped globals must not outlive the module load either.
        expect(out.self).toBe("undefined");
    }, 60_000);
});
