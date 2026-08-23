// Per-module loader boilerplate, shared by the single-export wasm modules.
//
// `wasm/loader.ts` owns the hard part — the Node/browser/injected branch and
// the init-once memo. What is left around it is identical for every consumer:
// a subpath import, the Node `file://` hop, a `configure*` entry point, and a
// module singleton whose accessor throws before init. `jubjub` and `poseidon`
// differ only in three strings and their module interface, so they share this.
//
// `prover` does not: it needs a `postInit` rayon hook and its own thread-count
// configuration, so it calls `createWasmLoader` directly.
//
// Bundler contract, inherited by every caller:
//
//   - The subpath specifier reaches `import()` as a *variable*, and the call
//     carries `@vite-ignore`, so Vite leaves it for the runtime to resolve.
//   - `new URL(..., import.meta.url)` stays in the caller. It resolves against
//     the importing module's own URL, so moving it here would silently rebase
//     every path onto this file.

import { createWasmLoader, type WasmLoaderOverride, type WasmModuleBase } from "./loader.js";
import { nodeFileUrlToPath } from "./node-path.js";

export interface ModuleLoaderConfig {
    /**
     * The type that owns this module's lifecycle, e.g. `"Poseidon"`. Names the
     * module in diagnostics and points an early caller at `<owner>.build()`.
     */
    owner: string;
    /** Package subpath import (`#wasm/<name>`), declared in package.json `imports`. */
    subpath: string;
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
    cfg: ModuleLoaderConfig,
): ModuleLoader<M> {
    const loader = createWasmLoader<M>({
        name: cfg.owner,
        // `cfg.subpath` is a variable, so Vite cannot statically resolve it;
        // `@vite-ignore` stops it warning about that.
        defaultImport: () => import(/* @vite-ignore */ cfg.subpath) as Promise<M>,
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
