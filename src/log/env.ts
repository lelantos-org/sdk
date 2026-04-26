// Environment-variable knobs, read as a pure function.
//
// Nothing here runs at import time — `connect()` calls `loggingFromEnv()`
// once and passes the result to `configureLogging`. That preserves
// `sideEffects: false` and leaves programmatic configuration in charge when
// both are present.
//
// | Variable                          | Effect                                    |
// |-----------------------------------|-------------------------------------------|
// | LELANTOS_LOG                       | namespace globs, e.g. `lelantos:prover:*` |
// | LELANTOS_LOG_LEVEL                 | error｜warn｜info｜debug｜trace           |
// | LELANTOS_PROVER_THREADS            | rayon thread count (not a log knob)       |
// | LELANTOS_PROVER_ARTIFACTS_DIR      | artifact lookup dir (not a log knob)      |
// | LELANTOS_DEBUG                     | rayon worker bootstrap only — see below   |
//
// `wasm/rayon/bootstrap.mjs` is a raw asset spawned by Node before any SDK
// module loads, so it cannot use this table; it reads `LELANTOS_DEBUG`
// directly. That is the one documented exception.

import type { LoggingConfig, LogLevel } from "./logger.js";

const LEVELS = new Set<string>(["silent", "error", "warn", "info", "debug", "trace"]);

function env(name: string): string | undefined {
    if (typeof process === "undefined") return undefined;
    return process.env?.[name] || undefined;
}

/**
 * Logging configuration implied by the environment, or `null` when no
 * logging variables are set. Never reads anything at import time.
 */
export function loggingFromEnv(): LoggingConfig | null {
    const namespaces = env("LELANTOS_LOG");
    const rawLevel = env("LELANTOS_LOG_LEVEL");
    if (!namespaces && !rawLevel) return null;

    const level: LogLevel = rawLevel && LEVELS.has(rawLevel) ? (rawLevel as LogLevel) : "debug";
    return { level, namespaces: namespaces ?? null };
}

/** Rayon worker count override, if set and valid. */
export function envProverThreads(): number | undefined {
    const raw = env("LELANTOS_PROVER_THREADS");
    if (!raw) return undefined;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** Directory holding `2x2.wasm` + `2x2_final.zkey`, if set. */
export function envArtifactsDir(): string | undefined {
    return env("LELANTOS_PROVER_ARTIFACTS_DIR");
}
