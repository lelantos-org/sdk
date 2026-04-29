// Top-level barrel.

export * from "./crypto/index";
export * from "./notes";
export * from "./keys";
export * from "./address";
export * from "./fmd";
export * from "./note-encrypt";
export * from "./cache";
export * from "./prover";
export * from "./witness";
export * from "./witness/tree-update";
export * from "./snark-compression";
export * from "./relayer";
export * from "./operator";
export * from "./sync";
export * from "./note-codec";
export * from "./aux";
export * from "./bundle";
export * from "./permit";
export * as metamask from "./metamask";

// High-level Wallet API for application integration. Primitives above stay
// public; this layer is purely additive.
//
// All five external dependencies are pluggable interfaces:
//   ChainAdapter, NoteSource, Submitter, Prover, CoinSelector, NoteStore.
// Defaults: EthersChainAdapter, FmdNoteSource, HttpRelayerSubmitter,
// SnarkjsProver, SfrtCoinSelector, InMemoryNoteStore.
export * from "./wallet";
export * from "./wallet/config";
export * from "./wallet/key-source";
export * from "./wallet/note-store";
export * from "./wallet/selection";
export * from "./wallet/randomness";
export * from "./wallet/fmd-client";
export * from "./wallet/chain-adapter";
export * from "./wallet/note-source";
export * from "./wallet/submitter";
export * from "./wallet/prover";
export * from "./wallet/sync";
export * from "./wallet/adapters/ethers-chain";
