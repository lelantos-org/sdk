// `serveWorkerRpc` must reach the message port under `node:worker_threads`.
//
// The client half (`./client.ts`) accepts a Node worker and `./types.test.ts`
// pins that. The server half resolves its scope at runtime: in a browser worker
// `globalThis` is the port, under Node it is not, and messages arrive on
// `parentPort` instead. A scope injected by a test double would not exercise
// that resolution, so this spawns a real worker.
//
// Runs against `dist/`, which is where the worker entry a consumer loads comes
// from; skipped when the package has not been built.

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { describe, expect, it } from "vitest";

const DIST = fileURLToPath(new URL("../../dist/worker/serve.js", import.meta.url));
const built = existsSync(DIST);

/** A worker that answers one method, wired only through `serveWorkerRpc`. */
const SOURCE = `
import { serveWorkerRpc } from ${JSON.stringify(DIST)};
serveWorkerRpc({ echo: async ({ n }) => ({ n: n * 2 }) });
`;

function callEcho(n: number, timeoutMs = 15_000): Promise<unknown> {
    const worker = new Worker(SOURCE, { eval: true });
    return new Promise((resolve, reject) => {
        const timer = setTimeout(
            () => reject(new Error("worker did not reply: scope resolution failed")),
            timeoutMs,
        );
        worker.on("message", (msg) => {
            clearTimeout(timer);
            resolve(msg);
        });
        worker.on("error", (err) => {
            clearTimeout(timer);
            reject(err);
        });
        worker.postMessage({ id: 1, method: "echo", params: { n } });
    }).finally(() => void worker.terminate());
}

describe.skipIf(!built)("serveWorkerRpc under node:worker_threads", () => {
    it("replies on parentPort", async () => {
        expect(await callEcho(21)).toEqual({ id: 1, ok: true, result: { n: 42 } });
    }, 20_000);

    it("delivers a message posted before the handler installs", async () => {
        // The Node scope is reached through a dynamic import, so the listener
        // attaches a tick late. The port queues until then; this pins that.
        expect(await callEcho(1)).toEqual({ id: 1, ok: true, result: { n: 2 } });
    }, 20_000);
});
