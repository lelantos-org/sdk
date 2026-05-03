// Shared loader for wasm-pack (`--target web`) modules consumed by the SDK.
// Centralises the Node vs browser vs injected-loader branch + the lazy
// init-once promise that each wasm crate would otherwise duplicate.
//
// Specifiers passed to `defaultImport()` are package subpath imports
// (`#wasm/<name>`) declared in the SDK's package.json. Both Node ESM and
// bundlers (Vite, Webpack, Rollup) honour `imports`, so consumers do not
// need to wire any per-crate path configuration.

export interface WasmModuleBase {
    default: (input?: { module_or_path?: BufferSource | string | URL }) => Promise<unknown>;
}

export interface WasmLoaderOverride<M extends WasmModuleBase> {
    /// Return the wasm-pack JS module (a dynamic
    /// `import("@lelantos-org/sdk/wasm/<name>")`).
    loadModule(): Promise<M>;
    /// URL or bytes for the `.wasm` binary. If omitted, the wasm-pack
    /// module's own auto-init runs and fetches the binary relative to the
    /// JS module URL.
    wasm?: BufferSource | string | URL;
}

export interface WasmLoaderInitCtx {
    isNode: boolean;
    nodePkgUrl: string | null;
}

export interface WasmLoaderConfig<M extends WasmModuleBase> {
    name: string;
    /// Loads the wasm-pack JS module. Caller closes over the subpath import
    /// so the specifier is statically analyzable by bundlers.
    defaultImport(): Promise<M>;
    /// Returns the absolute filesystem path of the `.wasm` binary on Node
    /// (read into bytes and passed to `mod.default`). Skipped on browser.
    nodeWasmPath(): Promise<string>;
    /// Returns the JS module URL on Node (a `file://` href). Used for
    /// `getNodePkgUrl()` so downstream features (wasm-bindgen-rayon) can
    /// spawn workers pointing at the same module.
    nodeJsUrl(): Promise<string>;
    /// Optional post-init hook (e.g. rayon thread-pool setup).
    postInit?(mod: M, ctx: WasmLoaderInitCtx): Promise<void>;
}

export interface WasmLoaderHandle<M extends WasmModuleBase> {
    configure(loader: WasmLoaderOverride<M>): void;
    load(): Promise<M>;
    /// Last Node `pkg/` JS-module URL (set after `load()` on Node).
    getNodePkgUrl(): string | null;
}

const IS_NODE = typeof process !== "undefined" && !!process.versions?.node;

// String constants assigned to variables so Vite's static analysis treats
// the dynamic-import target as unknown and stops trying to resolve the
// `node:*` specifier in browser bundles. Reachable only on Node (gated by
// `IS_NODE`), so the externalization warning is a false positive.
const NODE_FS_PROMISES = "node:fs/promises";

export function createWasmLoader<M extends WasmModuleBase>(
    cfg: WasmLoaderConfig<M>,
): WasmLoaderHandle<M> {
    let injected: WasmLoaderOverride<M> | null = null;
    let promise: Promise<M> | null = null;
    let nodePkgUrl: string | null = null;

    async function init(): Promise<M> {
        let mod: M;
        if (injected) {
            mod = await injected.loadModule();
            await mod.default(
                injected.wasm !== undefined ? { module_or_path: injected.wasm } : undefined,
            );
        } else if (IS_NODE) {
            const { readFile } = await import(/* @vite-ignore */ NODE_FS_PROMISES);
            nodePkgUrl = await cfg.nodeJsUrl();
            mod = await cfg.defaultImport();
            const bytes = new Uint8Array(await readFile(await cfg.nodeWasmPath()));
            await mod.default({ module_or_path: bytes });
        } else {
            mod = await cfg.defaultImport();
            await mod.default();
        }
        if (cfg.postInit) await cfg.postInit(mod, { isNode: IS_NODE, nodePkgUrl });
        return mod;
    }

    return {
        configure(loader: WasmLoaderOverride<M>): void {
            injected = loader;
            promise = null;
            nodePkgUrl = null;
        },
        load(): Promise<M> {
            if (!promise) promise = init();
            return promise;
        },
        getNodePkgUrl(): string | null {
            return nodePkgUrl;
        },
    };
}
