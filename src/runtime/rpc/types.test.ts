// Assignability pins for `WorkerLike`.
//
// The interface accepts a DOM `Worker` and a `node:worker_threads` Worker
// through one type. This is a compile-time property, so narrowing a handler
// parameter would break consumers (forcing `as unknown as WorkerLike`) without
// failing a runtime test. These assertions are checked by `npm run typecheck`.

import type { Worker as NodeWorker } from "node:worker_threads";
import { expect, it } from "vitest";
import type { WorkerLike } from "./types.js";

// The assertions are the three annotations below (tsconfig.test.json covers
// this file); the `it` exists only so vitest does not report an empty suite.
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
