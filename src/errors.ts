import type { ErrorPayload } from "./protocol.js";

/**
 * What a failed request rejects with: an Error that also carries the wallet API's error code, as
 * the extension's wallet object rejects (its `WalletRequestError`).
 */
export class WalletRequestError extends Error {
  readonly code: number;
  readonly data?: string;

  constructor(payload: ErrorPayload) {
    super(payload.data ? `${payload.message}: ${payload.data}` : payload.message);
    this.name = "WalletRequestError";
    this.code = payload.code;
    this.data = payload.data;
  }
}
