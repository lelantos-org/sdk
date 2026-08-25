// Prover artifacts: the public face of `artifact-paths` + `artifact-bytes`.
//
// The two halves answer different questions — *which file, and where* versus
// *what is in it* — and only the first runs on `connect()`'s critical path.
// They were one module until the byte cache, the retrying fetch and the
// progress reader had grown past the lookup logic they were filed next to.
//
// This barrel exists so that split stayed invisible to the twelve call sites
// importing `./artifacts.js`, and so `prover/index.ts` keeps one place to
// re-export from. Import the halves directly when you only need one; both are
// tier-equal, and neither imports the other.

export {
    __resetArtifactCacheForTest,
    configureArtifactCache,
    type LoadArtifactOpts,
    loadArtifactBytes,
    releaseArtifactBytes,
} from "./artifact-bytes.js";
export {
    bundledProverArtifacts,
    type ProverArtifacts,
    resolveArtifacts,
} from "./artifact-paths.js";
