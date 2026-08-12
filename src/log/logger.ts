// Namespaced, levelled logging. Off by default and free when off.
//
// COST MODEL
// ----------
// With no sink installed, `currentLevel` is 0 and every method returns after
// a single integer compare. Two call-site rules keep that guarantee real:
//
//   1. Never interpolate into the message — pass a `fields` object instead.
//      `log.debug("scan chunk", { from, to })`, not `log.debug(\`scan ${from}\`)`.
//   2. In per-item loops, guard with `log.enabled("debug")` so even the
//      fields object is not allocated.
//
// The console sink lives in a separate module so its formatting code is
// tree-shaken out unless a consumer imports it. This module contains only
// declarations and two module-level bindings, so `sideEffects: false` in
// package.json stays truthful.
//
// State is module-local. Two copies of the SDK in one bundle each need
// configuring — the same caveat `isWalletError` documents.

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
let matchers: RegExp[] | null = null;

/** Install (or clear) the logging configuration. Affects all loggers. */
export function configureLogging(config: LoggingConfig): void {
    if (config.level !== undefined) currentRank = RANK[config.level];
    if (config.sink !== undefined) currentSink = config.sink;
    if (config.namespaces !== undefined) matchers = compile(config.namespaces);
}

/** Snapshot of the active configuration — forwarded to worker contexts. */
export function loggingConfig(): { level: LogLevel; namespaces: string[] | null } {
    const level =
        (Object.keys(RANK) as LogLevel[]).find((k) => RANK[k] === currentRank) ?? "silent";
    return { level, namespaces: matchers ? matchers.map((m) => m.source) : null };
}

function compile(ns: string | string[] | null): RegExp[] | null {
    if (ns === null) return null;
    const list = typeof ns === "string" ? ns.split(/[\s,]+/).filter(Boolean) : ns;
    if (list.length === 0) return null;
    return list.map(
        (g) => new RegExp(`^${g.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`),
    );
}

function emit(
    ns: string,
    level: Exclude<LogLevel, "silent">,
    msg: string,
    fields?: Record<string, unknown>,
): void {
    const sink = currentSink;
    if (!sink) return;
    if (matchers && !matchers.some((m) => m.test(ns))) return;
    try {
        sink({ level, ns, msg, fields, t: Date.now() });
    } catch {
        // A throwing sink must not break the operation being logged.
    }
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
 * Logger for a namespace. Cheap to call at module scope — construction
 * allocates one object and touches no global state.
 */
export function getLogger(ns: string): Logger {
    return new NsLogger(ns);
}
