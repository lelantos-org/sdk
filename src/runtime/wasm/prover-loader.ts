// Loader and configuration for the wasm-pack prover module.
//
// Separate from `wasm-prover.ts` so configuring the loader, which `configure-wasm.ts` re-exports
// from the root barrel, does not pull in the prover class and its witness-calculator glue.

import { EnvironmentError } from "../../errors/config.js";
import { getLogger } from "../../log/logger.js";
import { IS_NODE } from "../detect.js";
import { createWasmLoader, type WasmLoaderOverride, type WasmModuleBase } from "./loader.js";
import { initThreadPool, withWorkerGlobals } from "./rayon/index.js";

const log = getLogger("lelantos:prover:wasm");

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
    /**
     * Thread count as reported by rayon inside the wasm module, which can
     * differ from the worker count passed to `initThreadPool`. The prover
     * sizes MSM and FFT work from this value.
     */
    threadCount?: (() => number) | undefined;
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

const PKG_JS_URL = new URL("../../../wasm/prover/pkg/prover.js", import.meta.url);
const PKG_WASM_URL = new URL("../../../wasm/prover/pkg/prover_bg.wasm", import.meta.url);

const proverLoader = createWasmLoader<ProverModule>({
    defaultImport: () => import("#wasm/prover") as Promise<ProverModule>,
    nodeJsUrl: PKG_JS_URL,
    nodeWasmUrl: PKG_WASM_URL,
    postInit: async (mod, ctx) => {
        if (ctx.isNode && !ctx.nodePkgUrl) {
            throw new EnvironmentError("nodePkgUrl not set; call after wasm init");
        }
        const opts = { threadCount: proverThreadCount, label: "WasmProver" };
        await initThreadPool(mod, opts, ctx.isNode ? ctx.nodePkgUrl : null);
        // Logs the thread count the prover uses, which may be lower than the
        // requested pool size.
        const effective = mod.threadCount?.();
        if (effective !== undefined) log.info("prover thread count", { effective });
    },
});

/**
 * Browser bundlers rewrite the relative-path fallback to a path missing at
 * runtime. Inject a loader that resolves the wasm-pack module and binary via
 * the bundler's asset-URL pipeline before `WasmProver.build()`.
 */
export function configureProverWasm(loader: ProverWasmLoader): void {
    proverLoader.configure(loader);
}

/**
 * Forget the memoised prover module, so the next `loadProver()` re-runs
 * `postInit`, which starts the rayon thread pool.
 *
 * @internal
 */
export function resetProverModule(): void {
    proverLoader.reset();
}

/** @internal */
export async function loadProver(): Promise<ProverCtor> {
    // Worker-shaped globals are needed only while the pkg module evaluates;
    // `withWorkerGlobals` removes them afterwards so other libraries do not
    // detect the main thread as a Web Worker.
    const mod = IS_NODE
        ? await withWorkerGlobals(() => proverLoader.load())
        : await proverLoader.load();
    return mod.ProverSession;
}
