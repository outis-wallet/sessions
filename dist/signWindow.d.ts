import { type ConnectResult, type DeploymentResult, type SignResult, type TypedDataJson } from "./protocol.js";
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
    /**
     * How long it stays open, idle, once it answers deployment data asked after a sign-in, where the
     * site hasn't opened it ahead since (ms). `DATA_HOLD_MS` where not given.
     */
    dataHoldMs?: number;
};
/**
 * How long the window waits after it answers deployment data asked after a sign-in: the site has
 * done what follows a sign-in, and a signature it still asks for comes straight after.
 */
export declare const DATA_HOLD_MS = 3000;
/**
 * How long the window has to answer a request that asks nothing of the user (deployment data), once
 * it is the window's turn: it has the request and nothing that waits on the user is ahead of it.
 */
export declare const ANSWER_WITHIN_MS = 10000;
export declare class SignWindow {
    #private;
    constructor(options: SignWindowOptions, env?: Env);
    /** Whether the window is open. */
    get isOpen(): boolean;
    /**
     * Opens the window, or brings it forward where it is open. Call it in the click that leads to a
     * request when the request follows other work (a fetch): browsers block windows opened long after
     * the click. Throws where the browser blocks it. The window is then held `holdMs`, through
     * deployment data answered in it, until a sign-in.
     */
    open(): void;
    /** Closes the window; whatever it still had open is refused. */
    close(): void;
    /** Signs the user in, where the window has no one signed in, and answers with the account. The window then stays open `holdMs` for the next request. */
    connect(): Promise<ConnectResult>;
    /** The account's signature over `typedData`, signed for `account` only where it is given. The window closes after. */
    signTypedData(typedData: TypedDataJson, account: string | null): Promise<SignResult>;
    /**
     * How the signed-in account is deployed, which the window answers without asking the user anything
     * (it refuses where no one is signed in there). The window is left as it was: held open where it
     * was open, closed where this request opened it; a signature asked for beside it still closes the
     * window, whichever is answered last. Held after a sign-in, it is held `dataHoldMs` from the
     * answer, for a signature asked straight after; opened ahead (`open()`), `holdMs`. A window that
     * doesn't answer within `ANSWER_WITHIN_MS` of its turn (one that doesn't know the request) is a
     * refusal (163), not a wait without end.
     */
    deploymentData(): Promise<DeploymentResult>;
}
