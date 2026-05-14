// Configuration / deployment errors raised at `Wallet.connect`.

import { WalletError } from "./base.js";

/// `missing` lists every problem at once.
export class WalletConfigError extends WalletError {
    readonly missing: string[];
    constructor(missing: string[] | string) {
        const list = Array.isArray(missing) ? missing : [missing];
        super(
            "WALLET_CONFIG",
            list.length === 1
                ? `wallet config: ${list[0]}`
                : `wallet config: missing or invalid — ${list.join("; ")}`,
        );
        this.name = "WalletConfigError";
        this.missing = list;
    }
}

/// Preset is a placeholder pending public deployment. Surfaces at
/// `Wallet.connect` time instead of failing later as "invalid address".
export class NetworkNotDeployedError extends WalletError {
    readonly network: string;
    constructor(network: string) {
        super(
            "NETWORK_NOT_DEPLOYED",
            `network "${network}" has no public deployment yet. Pass a ` +
                `custom \`NetworkPreset\` with concrete addresses, or pick ` +
                `\`anvil\`/\`localnet\` for local dev.`,
        );
        this.name = "NetworkNotDeployedError";
        this.network = network;
    }
}
