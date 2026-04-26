// Console sink. Separate module so the formatting code below is tree-shaken
// out of bundles that never install it.

import type { LogRecord, LogSink } from "./logger.js";

export interface ConsoleSinkOptions {
    /** Prefix each line with `+Nms` since the previous record. Default true. */
    timestamps?: boolean;
    /** Override the console (tests, or a worker forwarding upstream). */
    console?: Pick<Console, "debug" | "info" | "warn" | "error">;
}

/**
 * Human-readable console output.
 *
 * ```ts
 * configureLogging({ level: "debug", sink: consoleSink() });
 * ```
 */
export function consoleSink(opts: ConsoleSinkOptions = {}): LogSink {
    const out = opts.console ?? console;
    const stamps = opts.timestamps ?? true;
    let prev = 0;

    return (r: LogRecord) => {
        const delta = stamps && prev ? ` +${r.t - prev}ms` : "";
        prev = r.t;
        const line = `[${r.ns}]${delta} ${r.msg}`;
        const args = r.fields ? [line, format(r.fields)] : [line];
        switch (r.level) {
            case "error":
                out.error(...args);
                break;
            case "warn":
                out.warn(...args);
                break;
            case "info":
                out.info(...args);
                break;
            default:
                out.debug(...args);
        }
    };
}

function format(fields: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(fields)) {
        out[k] = typeof v === "bigint" ? `${v}n` : v;
    }
    return out;
}
