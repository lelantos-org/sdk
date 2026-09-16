// Configuration and call-argument errors.

import { WalletError, type WalletErrorOptions } from "./base.js";

/** `missing` lists every problem at once. */
export class WalletConfigError extends WalletError<"WALLET_CONFIG"> {
    readonly missing: string[];
    constructor(missing: string[] | string, opts?: WalletErrorOptions) {
        const list = Array.isArray(missing) ? missing : [missing];
        super(
            "WALLET_CONFIG",
            list.length === 1
                ? `wallet config: ${list[0]}`
                : `wallet config: missing or invalid — ${list.join("; ")}`,
            opts,
        );
        this.name = "WalletConfigError";
        this.missing = list;
    }
}

/**
 * A caller passed an argument the SDK cannot act on. Distinct from
 * {@link WalletConfigError}, which is about wiring rather than a call.
 */
export class InvalidArgumentError extends WalletError<"INVALID_ARGUMENT"> {
    /**
     * The argument at fault: an option name (`"amount"`, `"feeAsset"`), a
     * dotted path into one (`"selection.maxInputs"`), or a parameter name.
     */
    readonly argument: string;
    constructor(message: string, opts: WalletErrorOptions & { argument: string }) {
        super("INVALID_ARGUMENT", message, opts);
        this.name = "InvalidArgumentError";
        this.argument = opts.argument;
    }
}

/** A required platform capability is missing (Web Crypto, workers, fetch). */
export class EnvironmentError extends WalletError<"ENVIRONMENT"> {
    constructor(message: string, opts?: WalletErrorOptions) {
        super("ENVIRONMENT", message, opts);
        this.name = "EnvironmentError";
    }
}

/**
 * Preset is a placeholder pending public deployment. Surfaces at
 * `connect()` time instead of failing later as "invalid address".
 */
export class NetworkNotDeployedError extends WalletError<"NETWORK_NOT_DEPLOYED"> {
    readonly network: string;
    constructor(network: string, opts?: WalletErrorOptions) {
        super(
            "NETWORK_NOT_DEPLOYED",
            `network "${network}" has no public deployment yet. Pick a ` +
                `deployed network (e.g. \`"base"\`) or pass a custom ` +
                `\`NetworkPreset\` with concrete addresses.`,
            opts,
        );
        this.name = "NetworkNotDeployedError";
        this.network = network;
    }
}
