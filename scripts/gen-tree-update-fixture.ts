// Generate a valid `tree_update` circuit input fixture for the WasmProver
// parity test. Mirrors `circuits/src/test/tree_update.test.ts` setupAt(0):
// empty tree, insert (cm0, cm1) at startIndex=0, capture pre/post roots and
// the pre-insert frontier.
//
// Run: npx tsx scripts/gen-tree-update-fixture.ts
// Writes: tests/fixtures/tree_update.input.json

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { Poseidon } from "../src/crypto/index";
import { MerkleTree } from "../src/crypto/merkle";
import { buildTreeUpdateInput } from "../src/witness/tree-update";

const DEPTH = 10;
const OUT = resolve(__dirname, "..", "tests", "fixtures", "tree_update.input.json");

async function main(): Promise<void> {
    const P = await Poseidon.build();

    const cm0 = 0xc01dn;
    const cm1 = 0xc02dn;
    const startIndex = 0;

    const before = new MerkleTree(P, DEPTH);
    const oldRoot = before.root();
    const frontier = before.frontier();

    const after = new MerkleTree(P, DEPTH);
    after.insert(cm0);
    after.insert(cm1);
    const newRoot = after.root();

    const input = buildTreeUpdateInput({
        oldRoot,
        newRoot,
        cm0,
        cm1,
        startIndex,
        frontier,
    });

    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, `${JSON.stringify(input, null, 2)}\n`);
    console.log(`wrote ${OUT}`);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
