// One operation's envelope: its correlation id, progress phases, `state().ops` entry and error
// boundary.

import { safeCall } from "../../core/callbacks.js";
import { randomHex } from "../../core/random.js";
import { InvalidArgumentError } from "../../errors/config.js";
import { isWalletError } from "../../errors/guard.js";
import type { OpOptions, OpRun, Phase, PhaseInfo } from "../types/options.js";
import type { OpActivity } from "../types/sync.js";
import { gated } from "./read.js";
import type { WalletStateStore } from "./state.js";

const OP_ID = /^[A-Za-z0-9_:.-]{1,64}$/;

/** Refuse a missing or non-object options argument. */
export function requireObject(args: unknown, op: string): asserts args is Record<string, unknown> {
    if (typeof args !== "object" || args === null) {
        throw new InvalidArgumentError(`${op}: pass an options object`, { argument: "args" });
    }
}

/** The `signal` of a method's options argument, which may not be an object at all. */
export function signalOf(args: unknown): AbortSignal | undefined {
    return (args as { signal?: AbortSignal } | null | undefined)?.signal;
}

/** The caller's `opId`, validated, or a freshly minted one. */
function resolveOpId(opId: unknown): string {
    if (opId === undefined) return randomHex(8);
    if (typeof opId !== "string" || !OP_ID.test(opId)) {
        throw new InvalidArgumentError(
            "opId must be 1–64 characters of [A-Za-z0-9_:.-]; it is a local correlation id",
            { argument: "opId" },
        );
    }
    return opId;
}

/**
 * Run `body` as operation `op`: disposal gate, `opId`, `state().ops` bookkeeping and the error
 * boundary, which also stamps `context.opId` on any `WalletError` that escapes.
 */
export function runOp<T, P extends Phase = Phase>(
    state: WalletStateStore,
    op: OpActivity["op"],
    opts: OpOptions<P> | undefined,
    body: (run: OpRun<P>) => Promise<T>,
): Promise<T> {
    return gated(
        state,
        op,
        async () => {
            if (opts !== undefined && (typeof opts !== "object" || opts === null)) {
                throw new InvalidArgumentError(`${op}: options must be an object`, {
                    argument: "options",
                });
            }
            const id = resolveOpId(opts?.opId);
            const onPhase = opts?.onPhase;
            state.opStarted(id, op);
            try {
                return await body({
                    opId: id,
                    op,
                    phase(phase, txHash) {
                        state.opPhase(id, phase);
                        if (onPhase) {
                            const info: PhaseInfo = txHash ? { opId: id, txHash } : { opId: id };
                            safeCall("onPhase", (p: P) => onPhase(p, info), phase);
                        }
                    },
                });
            } catch (err) {
                if (isWalletError(err)) {
                    const bag = (err as { context?: { opId?: string | undefined } }).context;
                    if (bag && bag.opId === undefined) bag.opId = id;
                }
                throw err;
            } finally {
                state.opSettled(id);
            }
        },
        opts?.signal,
    );
}
