// `ScannerOption` → a `Scanner`.

import type { Jubjub, Poseidon } from "../../crypto/index.js";
import { LocalScanner, type Scanner } from "../../sync/scanner.js";
import type { ScannerOption } from "../connect/options.js";

/** Whether `option` is a pre-built `Scanner` (caller-owned: the SDK never disposes it). */
function isScannerInstance(option: unknown): option is Scanner {
    return (
        typeof option === "object" &&
        option !== null &&
        typeof (option as { scan?: unknown }).scan === "function"
    );
}

/** A scanner and whether the SDK built it (and so disposes it). */
export interface BuiltScanner {
    readonly scanner: Scanner;
    /** `false` for a caller-supplied `Scanner`, whose lifetime stays with the caller. */
    readonly owned: boolean;
}

/**
 * Build the scanner `option` names: as-is (not owned), a worker pool (spawned now, so the builder
 * disposes it if a later step fails), or the in-process `LocalScanner` (default).
 *
 * The pool module loads dynamically, so an inline wallet never bundles the worker transport.
 */
export async function buildScanner(
    option: ScannerOption | undefined,
    deps: { J: Jubjub; P: Poseidon },
): Promise<BuiltScanner> {
    if (option === undefined || option === "inline") {
        return { scanner: new LocalScanner(deps.J, deps.P), owned: true };
    }
    if (isScannerInstance(option)) return { scanner: option, owned: false };
    const { browserWorkerScanner } = await import("../../sync/worker/pool.js");
    return {
        scanner: browserWorkerScanner({
            worker: option.workers,
            ...(option.size !== undefined ? { size: option.size } : {}),
        }),
        owned: true,
    };
}

/** Problems with a `scanner` option, for `WalletConfigError.missing`. Empty when valid. */
export function scannerOptionProblems(option: unknown): string[] {
    if (option === undefined || option === "inline" || isScannerInstance(option)) return [];
    if (
        typeof option === "object" &&
        option !== null &&
        typeof (option as { workers?: unknown }).workers === "function"
    ) {
        const size = (option as { size?: unknown }).size;
        if (size !== undefined && !(Number.isInteger(size) && (size as number) >= 1)) {
            return ["`scanner.size` (a positive integer)"];
        }
        return [];
    }
    return ['`scanner` (a `Scanner`, `{ workers, size? }` or "inline")'];
}
