// Assignability pins for `WorkerLike`.
//
// The interface exists to accept a DOM `Worker` and a `node:worker_threads`
// Worker through one type. That is a compile-time property with no runtime
// surface, so it cannot regress a normal test — it regresses silently the
// moment someone narrows a handler parameter, and the damage lands in
// consumer code as `as unknown as WorkerLike`. These assertions make
// `npm run typecheck` the thing that catches it.

import type { Worker as NodeWorker } from "node:worker_threads";
import { expect, it } from "vitest";
import type { WorkerLike } from "./types.js";

// The assertions are the three annotations below, checked by `npm run
// typecheck` (tsconfig.test.json covers this file); the `it` exists only so
// vitest does not report an empty suite. A DOM `Worker` stopping to satisfy
// `WorkerLike` is what put `as unknown as WorkerLike` in every browser
// consumer, and a narrowed handler parameter is all it takes to regress.
type DomAssignable = Worker extends WorkerLike ? true : false;
const _dom: DomAssignable = true;

// Node's Worker is an EventEmitter: `on`, but no `onmessage`, and
// `postMessage` takes `TransferListItem[]` rather than `Transferable[]`.
type NodeAssignable = NodeWorker extends WorkerLike ? true : false;
const _node: NodeAssignable = true;

const _double: WorkerLike = { postMessage: () => {}, terminate: () => {} };

it("WorkerLike accepts a DOM Worker, a Node Worker and a test double", () => {
    expect([_dom, _node, typeof _double.postMessage]).toEqual([true, true, "function"]);
});
