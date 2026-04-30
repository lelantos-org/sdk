// Convenience factories that hide the bundler-specific Worker URL plumbing.
//
// Browser apps using Vite, webpack, esbuild, or Rspack can swap their
// hand-written `WorkerPoolScanner({ factory: () => new Worker(new URL(...)) })`
// for `browserWorkerScanner({ size: 4 })`.
//
// `import.meta.url` resolves to this file in the dist bundle; modern bundlers
// (Vite ≥ 4, webpack ≥ 5, Rspack, esbuild ≥ 0.17, Bun) recognize the
// `new Worker(new URL(..., import.meta.url), { type: "module" })` pattern and
// emit a separate worker chunk automatically.

import {
    WorkerPoolScanner,
    type WorkerLike,
    type WorkerPoolScannerOpts,
} from "./scanner-worker-pool";

export interface BrowserWorkerScannerOpts
    extends Omit<WorkerPoolScannerOpts, "factory"> {
    /// Worker module URL. Required: SDK ships as CJS so it cannot reference
    /// `import.meta.url` here. Pass it from your ESM call site:
    ///   `workerUrl: new URL("@lelantos/sdk/scanner-worker", import.meta.url)`
    workerUrl: string | URL;
}

export function browserWorkerScanner(
    opts: BrowserWorkerScannerOpts,
): WorkerPoolScanner {
    const url = opts.workerUrl;
    return new WorkerPoolScanner({
        // Native Worker is structurally compatible with WorkerLike modulo
        // MessageEvent typing — cast through unknown.
        factory: () =>
            new Worker(url, { type: "module" }) as unknown as WorkerLike,
        size: opts.size,
        chunkSize: opts.chunkSize,
    });
}
