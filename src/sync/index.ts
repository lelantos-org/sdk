// Note scanning: the scanner port, the in-process implementation, and the
// worker pool.
//
// `./worker/entry.ts` is not re-exported: it is the Worker bootstrap for
// `WorkerPoolScanner`, published as the `@lelantos-org/sdk/scanner-worker`
// subpath. Re-exporting it would force every consumer to resolve worker
// bootstrap glue at module load.

export { type PathCheck, rootFromPath, verifyPath } from "../crypto/path.js";
export {
    emptyScanStats,
    type ScanHit,
    type ScanInput,
    type ScanStats,
    scanNotes,
} from "./scan.js";
export { LocalScanner, type Scanner } from "./scanner.js";
export {
    type BrowserWorkerScannerOpts,
    browserWorkerScanner,
    type WorkerFactory,
    WorkerPoolScanner,
    type WorkerPoolScannerOpts,
} from "./worker/pool.js";
export {
    decodeHit,
    decodeInput,
    encodeHit,
    encodeInput,
    type ScannerMethods,
    type ScanParams,
    transferablesOf,
    type WireScanHit,
    type WireScanInput,
    type WireWasmConfig,
} from "./worker/protocol.js";
