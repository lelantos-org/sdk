// Node-only path helper, used by every wasm module's loader config.

const NODE_URL = "node:url";

export async function nodeFileUrlToPath(url: URL): Promise<string> {
    const { fileURLToPath } = await import(/* @vite-ignore */ NODE_URL);
    return fileURLToPath(url);
}
