// Worker-shaped globals that `wasm-bindgen-rayon` needs in order to load
// under Node.
//
// `workerHelpers.js` touches `self.addEventListener` at module top level, so
// the stubs must exist before the pkg module is imported. They must also not
// outlive it: "am I in a worker?" is conventionally spelled
//
//     typeof self !== "undefined" && typeof postMessage === "function"
//
// so leaving `self`/`postMessage` on `globalThis` makes every library in the
// process treat a Node main thread as a Web Worker.
//
// Therefore: install only what is missing, record exactly that, and restore it
// once the pkg module has finished loading.

const STUBBED = ["addEventListener", "removeEventListener", "postMessage"] as const;

export interface InstalledGlobals {
    /** Undo the installation. Idempotent. */
    restore(): void;
}

/**
 * Install the stubs, returning a handle that removes precisely the keys this
 * call added — anything the host already defined is left untouched.
 */
export function installWorkerGlobals(): InstalledGlobals {
    const g = globalThis as Record<string, unknown>;
    const added: string[] = [];

    if (g.self === undefined) {
        g.self = globalThis;
        added.push("self");
    }
    for (const k of STUBBED) {
        if (g[k] === undefined) {
            g[k] = () => {};
            added.push(k);
        }
    }

    let restored = false;
    return {
        restore(): void {
            if (restored) return;
            restored = true;
            for (const k of added) delete g[k];
        },
    };
}

/**
 * Run `fn` with the stubs installed, then restore.
 *
 * The stubs are only needed while the pkg module evaluates: the main thread's
 * `workerHelpers` uses `new Worker(...)` afterwards, not `self.*`.
 */
export async function withWorkerGlobals<T>(fn: () => Promise<T>): Promise<T> {
    const handle = installWorkerGlobals();
    try {
        return await fn();
    } finally {
        handle.restore();
    }
}
