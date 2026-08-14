import { browserWorkerProver } from "@lelantos-org/sdk/prover";
export async function __block() {

const prover = browserWorkerProver({
    workerUrl: new URL("@lelantos-org/sdk/prover-worker", import.meta.url),
    paths: { circuit: wasmUrl, zkey: zkeyUrl },
});
const wallet = await connect({ network: "mainnet", signer, rpcUrl, prover });
}
