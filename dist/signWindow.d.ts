import { type ConnectResult, type SignResult, type TypedDataJson } from "./protocol.js";
/** The window as the SDK uses it: what `window.open` returns. */
export type WindowLike = {
    readonly closed: boolean;
    postMessage(message: unknown, targetOrigin: string): void;
    close(): void;
    focus(): void;
};
/** A message event, as far as the SDK reads one. */
export type MessageLike = {
    readonly source: unknown;
    readonly origin: string;
    readonly data: unknown;
};
/** What the window client needs of the page. `browserEnv()` in a browser; tests pass their own. */
export type Env = {
    /** This page's origin. */
    readonly origin: string;
    /** `window.open`, never with `noopener`: the window answers its opener. */
    open(url: string, features: string): WindowLike | null;
    /** Window features for a popup of this size. */
    features(width: number, height: number): string;
    onMessage(handler: (event: MessageLike) => void): void;
    /** 16 random bytes as 32 hex digits: a request's id. */
    randomId(): string;
};
/** The position of a `width` × `height` window centred over `over`, never above its top. */
export declare function centredOver(over: {
    left: number;
    top: number;
    width: number;
    height: number;
}, width: number, height: number): {
    left: number;
    top: number;
};
export declare function browserEnv(): Env;
export type SignWindowOptions = {
    /** Where the window lives (`SIGN_ORIGIN`). */
    signOrigin: string;
    /** The chain the site plays on, as the protocol writes it (`chainIdOf`). */
    chainId: string;
    /** How long the window stays open, idle, after it signs the user in or is opened ahead (ms). */
    holdMs: number;
};
export declare class SignWindow {
    #private;
    constructor(options: SignWindowOptions, env?: Env);
    /** Whether the window is open. */
    get isOpen(): boolean;
    /**
     * Opens the window, or brings it forward where it is open. Call it in the click that leads to a
     * request when the request follows other work (a fetch): browsers block windows opened long after
     * the click. Throws where the browser blocks it.
     */
    open(): void;
    /** Closes the window; whatever it still had open is refused. */
    close(): void;
    /** Signs the user in, where the window has no one signed in, and answers with the account. The window then stays open a while for the next request. */
    connect(): Promise<ConnectResult>;
    /** The account's signature over `typedData`, signed for `account` only where it is given. The window closes after. */
    signTypedData(typedData: TypedDataJson, account: string | null): Promise<SignResult>;
}
