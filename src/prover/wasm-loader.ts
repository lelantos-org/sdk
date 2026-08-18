// Loader and configuration for the wasm-pack prover module.
//
// Split from `wasm-prover.ts` so that configuring the loader does not pull the
// witness calculator. `wasm-prover.ts` statically imports `circom_runtime`
// (~26 KB with its `ffjavascript` dependency), and `configure-wasm.ts` is
// re-exported from the root barrel — without this split, every bundle that
// touches the barrel carries the witness calculator whether or not it ever
// proves anything.

import { createWasmLoader, type WasmLoaderOverride, type WasmModuleBase } from "../wasm/loader.js";
import { nodeFileUrlToPath } from "../wasm/node-path.js";
import {
    initBrowserThreadPool,
    initNodeThreadPool,
    withWorkerGlobals,
} from "../wasm/rayon/index.js";

const IS_NODE = typeof process !== "undefined" && !!process.versions?.node;

/** @internal */
export interface ProverSession {
    prove(wtnsBytes: Uint8Array): RawProofOutput;
}

/** @internal */
export type ProverCtor = new (zkeyBytes: Uint8Array) => ProverSession;

/** @internal */
export interface ProverModule extends WasmModuleBase {
    ProverSession: ProverCtor;
    initThreadPool?: ((n: number) => Promise<unknown>) | undefined;
}

/** @internal */
export interface RawProofOutput {
    piA: [string, string, string];
    piB: [[string, string], [string, string], [string, string]];
    piC: [string, string, string];
    publicSignals: string[];
}

export type ProverWasmLoader = WasmLoaderOverride<ProverModule>;

/**
 * Override rayon thread count. Pass 0 or 1 for single-threaded. Must be set
 * before the first `WasmProver.build` / `preload`; later changes are ignored.
 */
let proverThreadCount: number | null = null;
export function configureProverThreads(n: number): void {
    proverThreadCount = n;
}

const PKG_JS_URL = new URL("../../wasm/prover/pkg/prover.js", import.meta.url);
const PKG_WASM_URL = new URL("../../wasm/prover/pkg/prover_bg.wasm", import.meta.url);

const proverLoader = createWasmLoader<ProverModule>({
    name: "prover",
    defaultImport: () => import("#wasm/prover") as Promise<ProverModule>,
    nodeJsUrl: async () => PKG_JS_URL.href,
    nodeWasmPath: async () => nodeFileUrlToPath(PKG_WASM_URL),
    postInit: async (mod, ctx) => {
        const opts = { threadCount: proverThreadCount, label: "WasmProver" };
        if (ctx.isNode) {
            if (!ctx.nodePkgUrl) throw new Error("nodePkgUrl not set; call after wasm init");
            await initNodeThreadPool(mod, ctx.nodePkgUrl, opts);
        } else {
            await initBrowserThreadPool(mod, opts);
        }
    },
});

/**
 * Browser bundlers rewrite the relative-path fallback to a runtime-missing
 * path. Inject a loader that resolves the wasm-pack module + binary via the
 * bundler's asset-URL pipeline before `WasmProver.build()`.
 */
export function configureProverWasm(loader: ProverWasmLoader): void {
    proverLoader.configure(loader);
}

/**
 * Forget the memoised prover module, so the next `loadProver()` re-runs
 * `postInit` — which is what starts the rayon thread pool.
 *
 * @internal
 */
export function resetProverModule(): void {
    proverLoader.reset();
}

/** @internal */
export async function loadProver(): Promise<ProverCtor> {
    // The worker-shaped globals are only needed while the pkg module
    // evaluates; `withWorkerGlobals` removes them afterwards so the host's
    // main thread stops looking like a Web Worker to every other library.
    const mod = IS_NODE
        ? await withWorkerGlobals(() => proverLoader.load())
        : await proverLoader.load();
    return mod.ProverSession;
}
