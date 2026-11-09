import type { ErrorPayload } from "./protocol.js";
/**
 * What a failed request rejects with: an Error that also carries the wallet API's error code, as
 * the extension's wallet object rejects (its `WalletRequestError`).
 */
export declare class WalletRequestError extends Error {
    readonly code: number;
    readonly data?: string;
    constructor(payload: ErrorPayload);
}
