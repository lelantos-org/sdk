// Namespaced, levelled logging. Off by default, with negligible cost when off.
//
// COST MODEL
// ----------
// With the default level, `currentRank` is 0 and every method returns after a single integer
// compare. Two call-site rules preserve that:
//
//   1. Never interpolate into the message — pass a `fields` object instead.
//      `log.debug("scan chunk", { from, to })`, not `log.debug(\`scan ${from}\`)`.
//   2. In per-item loops, guard with `log.enabled("debug")` so even the
//      fields object is not allocated.
//
// The console sink lives in a separate module so its formatting code is tree-shaken out unless
// imported. This module contains only declarations and module-level bindings, consistent with
// `sideEffects: false` in package.json.
//
// State is module-local: two copies of the SDK in one bundle must each be configured (the same
// caveat `isWalletError` documents).

export type LogLevel = "silent" | "error" | "warn" | "info" | "debug" | "trace";

const RANK: Record<LogLevel, number> = {
    silent: 0,
    error: 1,
    warn: 2,
    info: 3,
    debug: 4,
    trace: 5,
};

export interface LogRecord {
    level: Exclude<LogLevel, "silent">;
    /** Colon-delimited namespace, e.g. `lelantos:sync:pool`. */
    ns: string;
    msg: string;
    fields?: Record<string, unknown> | undefined;
    /** Epoch milliseconds. */
    t: number;
}

export type LogSink = (record: LogRecord) => void;

export interface Logger {
    error(msg: string, fields?: Record<string, unknown>): void;
    warn(msg: string, fields?: Record<string, unknown>): void;
    info(msg: string, fields?: Record<string, unknown>): void;
    debug(msg: string, fields?: Record<string, unknown>): void;
    trace(msg: string, fields?: Record<string, unknown>): void;
    /** Guard for expensive field construction in hot paths. */
    enabled(level: LogLevel): boolean;
    /** Derive a sub-namespace: `getLogger("a").child("b")` logs as `a:b`. */
    child(suffix: string): Logger;
    readonly ns: string;
}

export interface LoggingConfig {
    /** Maximum level to emit. Default `"silent"`. */
    level?: LogLevel | undefined;
    /** Where records go. Without one, nothing is emitted at any level. */
    sink?: LogSink | null | undefined;
    /**
     * Namespace globs to include, e.g. `"lelantos:prover:*"` or
     * `["lelantos:http", "lelantos:sync:*"]`. Default: everything.
     */
    namespaces?: string | string[] | null | undefined;
}

let currentRank = 0;
let currentSink: LogSink | null = null;
// `globs` is the source of truth and `matchers` is derived from it. The original globs let
// `loggingConfig` round-trip: a compiled matcher's `.source` is a regex, which `configureLogging`
// would escape as a literal glob.
let globs: string[] | null = null;
let matchers: RegExp[] | null = null;

/** Install (or clear) the logging configuration. Affects all loggers. */
export function configureLogging(config: LoggingConfig): void {
    if (config.level !== undefined) currentRank = RANK[config.level];
    if (config.sink !== undefined) currentSink = config.sink;
    if (config.namespaces !== undefined) {
        globs = toGlobs(config.namespaces);
        matchers = globs === null ? null : globs.map(toMatcher);
    }
}

/**
 * Snapshot of the active level and namespace filter, in the form `configureLogging` accepts, for
 * replay into another realm (e.g. by the worker RPC client).
 */
export function loggingConfig(): { level: LogLevel; namespaces: string[] | null } {
    const level =
        (Object.keys(RANK) as LogLevel[]).find((k) => RANK[k] === currentRank) ?? "silent";
    return { level, namespaces: globs };
}

/** Parses the `string | string[] | null` filter input. */
function toGlobs(ns: string | string[] | null): string[] | null {
    if (ns === null) return null;
    const list = typeof ns === "string" ? ns.split(/[\s,]+/).filter(Boolean) : [...ns];
    return list.length > 0 ? list : null;
}

function toMatcher(glob: string): RegExp {
    return new RegExp(`^${glob.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);
}

/**
 * Push an already-formed record into the active sink.
 *
 * For records that crossed a realm boundary (e.g. forwarded by a worker), where the originating
 * realm already applied the level and namespace filters. Filters are not re-applied, so records
 * are not dropped when the two configurations differ.
 *
 * @internal
 */
export function emitRecord(record: LogRecord): void {
    const sink = currentSink;
    if (!sink) return;
    try {
        sink(record);
    } catch {
        // A throwing sink must not break the operation being logged.
    }
}

function emit(
    ns: string,
    level: Exclude<LogLevel, "silent">,
    msg: string,
    fields?: Record<string, unknown>,
): void {
    if (!currentSink) return;
    if (matchers && !matchers.some((m) => m.test(ns))) return;
    emitRecord({ level, ns, msg, fields, t: Date.now() });
}

class NsLogger implements Logger {
    constructor(readonly ns: string) {}

    error(msg: string, fields?: Record<string, unknown>): void {
        if (currentRank < 1) return;
        emit(this.ns, "error", msg, fields);
    }
    warn(msg: string, fields?: Record<string, unknown>): void {
        if (currentRank < 2) return;
        emit(this.ns, "warn", msg, fields);
    }
    info(msg: string, fields?: Record<string, unknown>): void {
        if (currentRank < 3) return;
        emit(this.ns, "info", msg, fields);
    }
    debug(msg: string, fields?: Record<string, unknown>): void {
        if (currentRank < 4) return;
        emit(this.ns, "debug", msg, fields);
    }
    trace(msg: string, fields?: Record<string, unknown>): void {
        if (currentRank < 5) return;
        emit(this.ns, "trace", msg, fields);
    }

    enabled(level: LogLevel): boolean {
        return currentRank >= RANK[level] && currentSink !== null;
    }

    child(suffix: string): Logger {
        return new NsLogger(`${this.ns}:${suffix}`);
    }
}

/**
 * Logger for a namespace. Safe to call at module scope: construction allocates one object and
 * touches no global state.
 */
export function getLogger(ns: string): Logger {
    return new NsLogger(ns);
}
