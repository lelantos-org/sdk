// WASM-backed Groth16 prover. Drop-in for `SnarkjsProver` — same `Prover`
// interface, same `ProveResult` shape (snarkjs decimal strings).
//
// Witness calc reuses `circom_runtime` (transitive via snarkjs ≥ 0.7) so apps
// need no new package. Proof runs in the rust ark-groth16 crate at
// `sdk/wasm/prover/`, with rayon multi-threading on COI pages.

import { WitnessCalculatorBuilder } from "circom_runtime";

import type { Prover } from "./prover";
import type { ProveResult, Groth16Proof, ProverPaths } from "../prover";

const IS_NODE = typeof process !== "undefined" && !!process.versions?.node;

// ── runtime types ──────────────────────────────────────────────────────────
interface ProverSession {
    prove(wtnsBytes: Uint8Array): RawProofOutput;
}
type ProverCtor = new (zkeyBytes: Uint8Array) => ProverSession;

interface ProverModule {
    default: (input?: { module_or_path?: Uint8Array }) => Promise<unknown>;
    ProverSession: ProverCtor;
}

interface WitnessCalculator {
    calculateWTNSBin(input: Record<string, unknown>, sanityCheck?: number): Promise<Uint8Array>;
}

interface RawProofOutput {
    piA: [string, string, string];
    piB: [[string, string], [string, string], [string, string]];
    piC: [string, string, string];
    publicSignals: string[];
}

// ── lazy singleton: load wasm-pack module + init the wasm binary ───────────
let proverPromise: Promise<ProverCtor> | null = null;
function loadProver(): Promise<ProverCtor> {
    if (!proverPromise) proverPromise = initProver();
    return proverPromise;
}

// Indirect eval: bypasses TS CJS lowering so `import()` stays a real ESM
// import. wasm-pack `--target web` output is ESM and require() rejects it.
const esmImport = new Function("s", "return import(s)") as (s: string) => Promise<any>;

async function initProver(): Promise<ProverCtor> {
    if (IS_NODE) polyfillSelfForNode();
    let mod: ProverModule;
    if (IS_NODE) {
        const { join } = await import("node:path");
        const { pathToFileURL } = await import("node:url");
        const pkgDir = join(__dirname, "..", "..", "wasm", "prover", "pkg");
        mod = (await esmImport(pathToFileURL(join(pkgDir, "prover.js")).href)) as ProverModule;
        await mod.default({ module_or_path: await readProverWasm() });
    } else {
        mod = (await esmImport("../../wasm/prover/pkg/prover.js")) as ProverModule;
        await mod.default();
    }
    return mod.ProverSession;
}

// `wasm-pack --target web` pulls in `wasm-bindgen-rayon`'s workerHelpers.js,
// which references `self.addEventListener` at module top level. Stub the
// Worker-shaped globals so module load succeeds in Node. No-op listeners
// never fire because we never call `initThreadPool` outside the browser.
function polyfillSelfForNode(): void {
    const g = globalThis as Record<string, unknown>;
    if (g.self === undefined) g.self = globalThis;
    for (const k of ["addEventListener", "removeEventListener", "postMessage"]) {
        if (g[k] === undefined) g[k] = () => {};
    }
}

async function readProverWasm(): Promise<Uint8Array> {
    const { readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    return new Uint8Array(
        await readFile(join(__dirname, "..", "..", "wasm", "prover", "pkg", "prover_bg.wasm")),
    );
}

async function loadBytes(path: string): Promise<Uint8Array> {
    if (IS_NODE) {
        const { readFile } = await import("node:fs/promises");
        return new Uint8Array(await readFile(path));
    }
    const res = await fetch(path);
    if (!res.ok) throw new Error(`fetch ${path}: ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
}

// ── public ─────────────────────────────────────────────────────────────────
export class WasmProver implements Prover {
    private constructor(
        private readonly session: ProverSession,
        private readonly wc: WitnessCalculator,
    ) {}

    static async build(paths: ProverPaths): Promise<WasmProver> {
        const [Session, zkeyBytes, circuitWasm] = await Promise.all([
            loadProver(),
            loadBytes(paths.zkeyPath),
            loadBytes(paths.wasmPath),
        ]);
        const wc = (await WitnessCalculatorBuilder(circuitWasm)) as WitnessCalculator;
        return new WasmProver(new Session(zkeyBytes), wc);
    }

    /// Warm the wasm module (zkey-independent). Use from `preloadWasm()` to
    /// avoid first-prove latency at the worst moment.
    static async preload(): Promise<void> {
        await loadProver();
    }

    async prove(input: Record<string, unknown>): Promise<ProveResult> {
        const wtns = await this.wc.calculateWTNSBin(input, 0);
        const out = this.session.prove(wtns);
        const proof: Groth16Proof = {
            pi_a: out.piA,
            pi_b: out.piB,
            pi_c: out.piC,
            protocol: "groth16",
            curve: "bn128",
        };
        return { proof, publicSignals: out.publicSignals };
    }
}
