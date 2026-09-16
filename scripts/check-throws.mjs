#!/usr/bin/env node
// Bare-error gate.
//
// Every failure that leaves the SDK should be a `WalletError`, so a caller can branch on `err.code`
// instead of matching message text. This walks the TypeScript AST of every shipped module under
// `src/` and fails on any place that still raises a bare built-in error:
//
//   throw new Error(...)            throw new RangeError(...)
//   throw new TypeError(...)        Promise.reject(new Error(...))
//
// The replacement is a typed error: `InvalidArgumentError` for a caller's input, `WireFormatError`
// for a server's response, `EnvironmentError` for a missing platform capability, and
// `assertInvariant` (→ `InternalError`) for a state the SDK itself guarantees. See
// `src/errors/base.ts`.

import { readFileSync } from "node:fs";
import { loadTs, shippedSources } from "./lib/package.mjs";

const ts = loadTs();

const BARE = new Set(["Error", "RangeError", "TypeError"]);

/** `Error` / `RangeError` / `TypeError` when `expr` is `new <that>(...)`. */
function bareName(expr) {
    if (!expr || !ts.isNewExpression(expr) || !ts.isIdentifier(expr.expression)) return undefined;
    return BARE.has(expr.expression.text) ? expr.expression.text : undefined;
}

/** The bare error a `Promise.reject(new Error(...))` call rejects with. */
function rejectedBareName(node) {
    if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return;
    const { expression: obj, name } = node.expression;
    if (!ts.isIdentifier(obj) || obj.text !== "Promise" || name.text !== "reject") return;
    return bareName(node.arguments[0]);
}

const sites = [];
for (const { abs, rel } of shippedSources()) {
    const sf = ts.createSourceFile(abs, readFileSync(abs, "utf8"), ts.ScriptTarget.Latest, true);
    const visit = (node) => {
        const thrown = ts.isThrowStatement(node) ? bareName(node.expression) : undefined;
        const rejected = thrown ? undefined : rejectedBareName(node);
        if (thrown || rejected) {
            const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
            const kind = thrown ? `throw new ${thrown}` : `Promise.reject(new ${rejected})`;
            sites.push(`src/${rel}:${line + 1}  ${kind}`);
        }
        ts.forEachChild(node, visit);
    };
    visit(sf);
}

if (sites.length > 0) {
    for (const s of sites.sort()) console.error(`  ${s}`);
    console.error(
        `\ncheck-throws: FAIL — ${sites.length} bare error site(s); throw a WalletError subclass instead.`,
    );
    process.exit(1);
}
console.log("check-throws: OK — no bare error sites in shipped src/");
