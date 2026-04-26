// Logging. Off by default; install a sink to see anything.
//
// ```ts
// import { configureLogging, consoleSink } from "@lelantos-org/sdk/log";
// configureLogging({ level: "debug", sink: consoleSink(), namespaces: "lelantos:sync:*" });
// ```

export { type ConsoleSinkOptions, consoleSink } from "./console-sink.js";
export { envArtifactsDir, envProverThreads, loggingFromEnv } from "./env.js";
export {
    configureLogging,
    getLogger,
    type Logger,
    type LoggingConfig,
    type LogLevel,
    type LogRecord,
    type LogSink,
    loggingConfig,
} from "./logger.js";
export { timed, timedSync } from "./timed.js";
