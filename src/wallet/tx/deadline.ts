// Deadlines in Unix seconds, as signatures and swap intents carry them.

import { unixNow } from "../../core/time.js";
import { InvalidArgumentError } from "../../errors/config.js";
import { DeadlinePassedError } from "../../errors/spend.js";
import { SWAP_DEFAULT_DEADLINE_SECS } from "../constants.js";

/** `explicit`, or `windowSecs` from now. */
export function deadlineOrDefault(
    explicit: bigint | undefined,
    windowSecs: number,
    nowSecs: bigint = BigInt(unixNow()),
): bigint {
    return explicit ?? nowSecs + BigInt(windowSecs);
}

/**
 * The swap's `deadline`: the caller's, or `now + SWAP_DEFAULT_DEADLINE_SECS`.
 *
 * Always explicit on the wire because the withdraw proof's intent hash covers it, so a
 * relayer-chosen default would not match the proof. A past deadline is rejected before proving,
 * since `SwapWrapper` would only refund it after fees are paid.
 */
export function resolveSwapDeadline(
    explicit: bigint | undefined,
    nowSecs: bigint = BigInt(unixNow()),
): bigint {
    const deadline = deadlineOrDefault(explicit, SWAP_DEFAULT_DEADLINE_SECS, nowSecs);
    assertBeforeDeadline(deadline, nowSecs);
    return deadline;
}

/** A caller's `deadline`: absent, or a positive bigint of Unix seconds. */
export function checkDeadlineArg(deadline: unknown): bigint | undefined {
    if (deadline === undefined) return undefined;
    if (typeof deadline !== "bigint" || deadline <= 0n) {
        throw new InvalidArgumentError("deadline must be a positive bigint of Unix seconds", {
            argument: "deadline",
        });
    }
    return deadline;
}

/** Refuse to go on at or past `deadline` (`DEADLINE_PASSED`). */
export function assertBeforeDeadline(
    deadline: bigint | undefined,
    nowSecs: bigint = BigInt(unixNow()),
): void {
    if (deadline !== undefined && deadline <= nowSecs) throw new DeadlinePassedError(deadline);
}
