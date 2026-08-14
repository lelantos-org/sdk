import wasmUrl from "@lelantos-org/circuits/2x2/2x2.wasm?url";
import zkeyUrl from "@lelantos-org/circuits/2x2/2x2_final.zkey?url";
export async function __block() {
// Vite / Next.js

const wallet = await connect({
    network: "mainnet",
    signer,
    rpcUrl,
    proverArtifacts: { circuit: wasmUrl, zkey: zkeyUrl },
});
}
