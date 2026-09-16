// Resolving the `network` option, shared by `connect()` and `connectWatch()`.

import {
    isNetworkDeployed,
    NETWORKS,
    type NetworkPreset,
    type PlaceholderNetworkPreset,
} from "../../chain/networks.js";
import { NetworkNotDeployedError, WalletConfigError } from "../../errors/config.js";

/**
 * A preset name → its deployed preset, refusing an unknown or undeployed name. `undefined` for an
 * object, which the caller validates as a custom preset; anything else is refused.
 */
export function namedPreset(network: unknown): NetworkPreset | undefined {
    if (typeof network === "string") {
        const found = (NETWORKS as Record<string, NetworkPreset | PlaceholderNetworkPreset>)[
            network
        ];
        if (!found) {
            throw new WalletConfigError(
                `unknown network "${network}"; known: ${Object.keys(NETWORKS).join(", ")}`,
            );
        }
        if (!isNetworkDeployed(found)) throw new NetworkNotDeployedError(network);
        return found;
    }
    if (typeof network !== "object" || network === null) {
        throw new WalletConfigError("`network` (a preset name or a `NetworkPreset`)");
    }
    return undefined;
}
