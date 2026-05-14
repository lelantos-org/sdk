// HTTP/network failures from the relayer client and FMD client.

import { WalletError } from "./base.js";

/// HTTP failure after retries, or deadline expired. `cause` carries the
/// underlying network error.
export class NetworkError extends WalletError {
    readonly url: string;
    readonly status?: number;
    constructor(
        code: "RELAYER_TIMEOUT" | "RELAYER_FAILED" | "FMD_TIMEOUT" | "FMD_FAILED",
        url: string,
        message: string,
        opts?: { status?: number; cause?: unknown },
    ) {
        super(code, `${message} (${url})`, opts);
        this.name = "NetworkError";
        this.url = url;
        this.status = opts?.status;
    }
}
