// Loader boilerplate shared by the single-export wasm modules (`jubjub`,
// `poseidon`): a `configure*` entry point and a module singleton whose accessor
// throws before init, on top of `createWasmLoader`. `prover` calls
// `createWasmLoader` directly because it needs a `postInit` rayon hook.
//
// Bundler contract for callers:
//
//   - `importModule` stays in the caller so the `#wasm/<name>` specifier is a
//     literal at the `import()` call site. Bundlers follow only a dynamic
//     import they can read statically; behind a variable the bare specifier
//     survives into the output, where no browser can resolve it, and the
//     wasm-pack glue's `new URL(...)` is not rewritten to the emitted asset.
//   - `new URL(..., import.meta.url)` stays in the caller: it resolves against
//     the importing module's own URL.

import { EnvironmentError } from "../../errors/config.js";
import { createWasmLoader, type WasmLoaderOverride, type WasmModuleBase } from "./loader.js";

interface ModuleLoaderConfig<M extends WasmModuleBase> {
    /**
     * The type that owns this module's lifecycle, e.g. `"Poseidon"`. Names the
     * module in diagnostics and points an early caller at `<owner>.build()`.
     */
    owner: string;
    /**
     * Imports the wasm-pack JS module via its package subpath (`#wasm/<name>`,
     * declared in package.json `imports`). Must call `import()` with a literal
     * specifier; see the bundler contract above.
     */
    importModule: () => Promise<M>;
    /** `pkg/<name>.js`, resolved against the caller's `import.meta.url`. */
    pkgJsUrl: URL;
    /** `pkg/<name>_bg.wasm`, resolved against the caller's `import.meta.url`. */
    pkgWasmUrl: URL;
}

interface ModuleLoader<M extends WasmModuleBase> {
    /**
     * Install a loader override, for bundlers that rewrite
     * `new URL(..., import.meta.url)` to a runtime-invalid location. Call
     * before the owner's `build()`.
     */
    configure(override: WasmLoaderOverride<M>): void;
    /** Load the module, or reuse the in-flight/settled load. */
    ensureInit(): Promise<void>;
    /** The loaded module. Throws if `ensureInit` has not resolved. */
    w(): M;
}

export function createModuleLoader<M extends WasmModuleBase>(
    cfg: ModuleLoaderConfig<M>,
): ModuleLoader<M> {
    const loader = createWasmLoader<M>({
        defaultImport: () => cfg.importModule(),
        nodeJsUrl: cfg.pkgJsUrl,
        nodeWasmUrl: cfg.pkgWasmUrl,
    });

    let mod: M | null = null;

    return {
        configure(override: WasmLoaderOverride<M>): void {
            // An override installed after a successful load must not leave
            // the previous module readable.
            mod = null;
            loader.configure(override);
        },
        async ensureInit(): Promise<void> {
            mod = await loader.load();
        },
        w(): M {
            if (!mod) {
                throw new EnvironmentError(
                    `${cfg.owner} wasm not initialized; call ${cfg.owner}.build() first`,
                );
            }
            return mod;
        },
    };
}
