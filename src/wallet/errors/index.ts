// Re-export every wallet error from one barrel. Keep `import { ... } from
// "../errors.js"` (legacy) and `@lelantos-org/sdk/errors` working.

export { WalletError, type WalletErrorCode } from "./base.js";
export { NetworkNotDeployedError, WalletConfigError } from "./config.js";
export { NetworkError } from "./network.js";
export { ProverArtifactsMissingError, ProverError } from "./prover.js";
export {
    DepositAdapterError,
    type DepositStrategy,
    InsufficientCoverError,
    PermitRejectedError,
    SelectionError,
    TxMiningError,
} from "./tx.js";
