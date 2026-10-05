// Handles: the label rule `LelantosNameRegistrar` enforces, and parsing what a user types.
//
// A handle is a label in the registrar. A resolver per ENS parent serves it as `<label>.<parent>`,
// so the same handle may be written under several parents; which parents are genuine is the
// deployment's to say (the chain entry's `nameParents`), never inferred from the input.

import { InvalidArgumentError } from "../errors/config.js";

/** The ENS text key a handle's shielded address is served under, for every parent. */
export const NAME_TEXT_KEY = "xyz.lelantos.address";

export const NAME_LABEL_MIN_LENGTH = 3;
export const NAME_LABEL_MAX_LENGTH = 32;

/** Runs of `[a-z0-9]` joined by single hyphens: no leading, trailing or doubled hyphen. */
const LABEL = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Whether `label` is one the registrar accepts: `[a-z0-9-]`, 3 to 32 characters, no leading or
 * trailing hyphen and no two hyphens in a row. Mirrors `LelantosNameRegistrar.isValidLabel`.
 */
export function isNameLabel(label: string): boolean {
    return (
        label.length >= NAME_LABEL_MIN_LENGTH &&
        label.length <= NAME_LABEL_MAX_LENGTH &&
        LABEL.test(label)
    );
}

/** A handle as typed, split into its label and the parent it was written under, if any. */
export interface ParsedHandle {
    label: string;
    /** The parent named, lowercased; `undefined` for a bare label. */
    parent: string | undefined;
}

/**
 * Parse a handle: a bare label (`mehow`, `@mehow`) or a label under one of `parents`
 * (`mehow.lelantos.xyz`). Case is folded, which is the whole of ENS normalization for the
 * characters a label may hold.
 *
 * A name under any other parent is refused, however similar: a look-alike parent is served by
 * someone else's resolver.
 *
 * @throws {InvalidArgumentError} (`argument: "name"`) when the label is not valid or the parent is
 * not one of `parents`. `details.reason` is `"label"` or `"parent"`.
 */
export function parseHandle(input: unknown, parents: readonly string[] = []): ParsedHandle {
    if (typeof input !== "string") {
        throw new InvalidArgumentError("name must be a string", { argument: "name" });
    }
    const text = input.trim().toLowerCase().replace(/^@/, "");
    const dot = text.indexOf(".");
    const label = dot === -1 ? text : text.slice(0, dot);
    const parent = dot === -1 ? undefined : text.slice(dot + 1);
    if (parent !== undefined && !parents.some((p) => p.toLowerCase() === parent)) {
        throw new InvalidArgumentError(`"${parent}" is not a parent this deployment serves`, {
            argument: "name",
            details: { reason: "parent" },
        });
    }
    if (!isNameLabel(label)) {
        throw new InvalidArgumentError(
            `a handle is ${NAME_LABEL_MIN_LENGTH} to ${NAME_LABEL_MAX_LENGTH} characters of a-z, 0-9 and single hyphens, not starting or ending with one`,
            { argument: "name", details: { reason: "label" } },
        );
    }
    return { label, parent };
}

/** `label` under `parent`, e.g. `mehow.lelantos.xyz`. */
export function formatHandle(label: string, parent: string): string {
    return `${label}.${parent}`;
}
