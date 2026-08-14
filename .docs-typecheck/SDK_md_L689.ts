import { requestPersistentStorage } from "@lelantos-org/sdk/core";
import { clearArtifactCache, configureArtifactCache } from "@lelantos-org/sdk/prover";
export async function __block() {

// Recommended once at startup: WebKit evicts Cache API storage after ~7 days
// without a visit, which silently restores the cold start. This covers every
// store the origin owns, so a persisted note or tree store benefits too.
await requestPersistentStorage();

await clearArtifactCache();        // reclaim ~85 MB, or force a re-download
configureArtifactCache(false);     // opt out entirely
configureArtifactCache(myCache);   // or store them in IndexedDB / OPFS / disk
}
