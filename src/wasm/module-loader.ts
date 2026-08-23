// Per-module loader boilerplate, shared by the single-export wasm modules.
//
// `wasm/loader.ts` owns the hard part — the Node/browser/injected branch and
// the init-once memo. What is left around it is identical for every consumer:
// a subpath import, the Node `file://` hop, a `configure*` entry point, and a
// module singleton whose accessor throws before init. `jubjub` and `poseidon`
// differ only in two strings, an import thunk, and their module interface, so
// they share this.
//
// `prover` does not: it needs a `postInit` rayon hook and its own thread-count
// configuration, so it calls `createWasmLoader` directly.
//
// Bundler contract, inherited by every caller:
//
//   - `importModule` stays in the caller so the `#wasm/<name>` specifier is a
//     literal at the `import()` call site. Bundlers only follow a dynamic
//     import they can read statically; behind a variable the specifier survives
//     into the output as a bare `#wasm/...`, which no browser can resolve, and
//     the wasm-pack glue never gets its `new URL(...)` rewritten to the emitted
//     asset. See `wasm/loader.ts`'s `defaultImport` contract.
//   - `new URL(..., import.meta.url)` likewise stays in the caller. It resolves
//     against the importing module's own URL, so moving it here would silently
//     rebase every path onto this file.

import { createWasmLoader, type WasmLoaderOverride, type WasmModuleBase } from "./loader.js";
import { nodeFileUrlToPath } from "./node-path.js";

export interface ModuleLoaderConfig<M extends WasmModuleBase> {
    /**
     * The type that owns this module's lifecycle, e.g. `"Poseidon"`. Names the
     * module in diagnostics and points an early caller at `<owner>.build()`.
     */
    owner: string;
    /**
     * Imports the wasm-pack JS module via its package subpath (`#wasm/<name>`,
     * declared in package.json `imports`). Must call `import()` with a literal
     * specifier — see the bundler contract above.
     */
    importModule: () => Promise<M>;
    /** `pkg/<name>.js`, resolved against the *caller's* `import.meta.url`. */
    pkgJsUrl: URL;
    /** `pkg/<name>_bg.wasm`, resolved against the *caller's* `import.meta.url`. */
    pkgWasmUrl: URL;
}

export interface ModuleLoader<M extends WasmModuleBase> {
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
        name: cfg.owner,
        defaultImport: () => cfg.importModule(),
        nodeJsUrl: async () => cfg.pkgJsUrl.href,
        nodeWasmPath: () => nodeFileUrlToPath(cfg.pkgWasmUrl),
    });

    let mod: M | null = null;

    return {
        configure(override: WasmLoaderOverride<M>): void {
            // Dropped alongside the memo: an override installed after a
            // successful load must not leave the previous module readable.
            mod = null;
            loader.configure(override);
        },
        async ensureInit(): Promise<void> {
            mod = await loader.load();
        },
        w(): M {
            if (!mod) {
                throw new Error(
                    `${cfg.owner} wasm not initialized; call ${cfg.owner}.build() first`,
                );
            }
            return mod;
        },
    };
}
