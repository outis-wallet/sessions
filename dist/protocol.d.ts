/** Where the window lives. A local page in development is named in `SessionOptions.signOrigin`. */
export declare const SIGN_ORIGIN = "https://sign.outis.xyz";
export declare const PROTOCOL_VERSION = 1;
/** The size of the window, in CSS pixels. */
export declare const WINDOW_SIZE: {
    width: number;
    height: number;
};
/** The most a message to sign may take, in characters of JSON. */
export declare const MAX_TYPED_DATA_LENGTH = 65536;
/** The most felts a signature may have. */
export declare const MAX_SIGNATURE_FELTS = 64;
/** The SNIP-12 message a site asks the window to sign, as JSON: what `wallet_signTypedData` takes. */
export type TypedDataJson = {
    types: Record<string, unknown>;
    primaryType: string;
    domain: Record<string, unknown>;
    message: Record<string, unknown>;
};
type Envelope = {
    outis: "sessions";
    v: typeof PROTOCOL_VERSION;
};
export type ConnectRequest = Envelope & {
    kind: "request";
    id: string;
    method: "connect";
    chainId: string;
};
export type SignRequest = Envelope & {
    kind: "request";
    id: string;
    method: "signTypedData";
    chainId: string;
    /** The account the site knows the user by, or null where it knows none: the window signs for that one only. */
    account: string | null;
    typedData: TypedDataJson;
};
/** Site → window. */
export type SessionRequest = ConnectRequest | SignRequest;
export type ConnectResult = {
    address: string;
};
export type SignResult = {
    address: string;
    signature: string[];
};
/** As the Starknet wallet API writes its errors: `{ code: 113, message: "An error occurred (USER_REFUSED_OP)" }`. */
export type ErrorPayload = {
    code: number;
    message: string;
    data?: string;
};
/** Window → site. */
export type WindowMessage = (Envelope & {
    kind: "ready";
}) | (Envelope & {
    kind: "response";
    id: string;
    result: unknown;
}) | (Envelope & {
    kind: "response";
    id: string;
    error: ErrorPayload;
});
/** The wallet API's codes Outis answers with, as the extension does. */
export declare const ERRORS: {
    readonly UNLISTED_NETWORK: 112;
    readonly USER_REFUSED_OP: 113;
    readonly INVALID_REQUEST_PAYLOAD: 114;
    readonly API_VERSION_NOT_SUPPORTED: 162;
    readonly UNKNOWN_ERROR: 163;
};
/** An error in the wallet API's words: `walletError("USER_REFUSED_OP", "The Outis window was closed")`. */
export declare function walletError(name: keyof typeof ERRORS, data?: string): ErrorPayload;
/** A felt as the protocol writes one: `0x`, lowercase hex with no leading zero, below the field's prime. */
export declare const isFelt: (value: unknown) => value is string;
/** An address as the protocol writes one: `0x` and 64 lowercase hex digits, not 0, below 2^251. */
export declare const isAddress: (value: unknown) => value is string;
/** A chain id as the protocol writes one: `0x`, lowercase hex with no leading zero, 31 bytes at most. */
export declare const isChainId: (value: unknown) => value is string;
/**
 * A chain id written the protocol's way, from hex in any case (`0x534E5F5345504F4C4941`), or
 * undefined where it isn't one.
 */
export declare function chainIdOf(value: unknown): string | undefined;
/** A message to sign, if `value` is one: the four parts SNIP-12 has, nothing else, plain JSON, not too large. */
export declare function typedDataOf(value: unknown): TypedDataJson | undefined;
/** A request, as the window reads one from the site (and the SDK checks one before sending), or null. */
export declare function parseRequest(value: unknown): SessionRequest | null;
/** A message from the window, as the SDK reads one, or null. What a result holds is read by `connectResultOf` and `signResultOf`. */
export declare function parseWindowMessage(value: unknown): WindowMessage | null;
/** The id a message names as an answer, where it reads as one (envelope, kind, id) whatever else it holds. */
export declare function responseIdOf(value: unknown): string | undefined;
/** A connect answer's result, if it is one: the account's address. */
export declare function connectResultOf(value: unknown): ConnectResult | undefined;
/** A signature answer's result, if it is one: the account that signed and its signature, felts. */
export declare function signResultOf(value: unknown): SignResult | undefined;
/** The window's address for a site: the site's origin, where the window posts `ready`, and the chain it plays on. */
export declare function windowUrl(signOrigin: string, site: string, chainId: string): string;
export {};
