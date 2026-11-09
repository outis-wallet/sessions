import { type Env } from "./signWindow.js";
export declare const SESSIONS_VERSION = "0.1.0";
/** The extension's object, where it puts it: `window.starknet_outis`. */
export declare const EXTENSION_GLOBAL = "starknet_outis";
export type WalletEvent = "accountsChanged" | "networkChanged";
type Handler = (...args: unknown[]) => void;
/** The standard Starknet wallet object, as Outis gives it. */
export type StarknetWallet = {
    id: string;
    name: string;
    version: string;
    icon: string | {
        dark: string;
        light: string;
    };
    request(call: {
        type: string;
        params?: unknown;
    }): Promise<unknown>;
    on(event: WalletEvent, handler: Handler): void;
    off(event: WalletEvent, handler: Handler): void;
};
export type SessionWallet = StarknetWallet & {
    /** Which Outis answers: the extension, or the sign.outis.xyz window. */
    readonly kind: "extension" | "window";
    /**
     * The window only: opens it, in the click that leads to a request which follows other work (a
     * fetch), as browsers block windows opened long after the click. Throws where the browser blocks it.
     */
    open(): void;
    /** The window only: this site forgets the account (signing out), and closes the window. */
    forget(): void;
};
/** Where the site remembers the account the window signed in, as `localStorage` does. */
export type StorageLike = {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
    removeItem(key: string): void;
};
export type SessionOptions = {
    /** The chain the site plays on, in hex: `0x534e5f5345504f4c4941` (SN_SEPOLIA). */
    chainId: string;
    /** Where the window lives: sign.outis.xyz, or a local page in development. */
    signOrigin?: string;
    /** How long the window stays open, idle, after it signs the user in or is opened ahead (ms). 30 s. */
    holdMs?: number;
    /** Where the account is remembered: the page's `localStorage`, or null for nowhere. */
    storage?: StorageLike | null;
    /** false: the window even where the extension is installed. */
    extension?: boolean;
    /** For tests: the page, as the window client sees it. */
    env?: Env;
};
export declare const ICON: {
    dark: string;
    light: string;
};
/** The extension's object in this page, if it is installed. */
export declare function findExtension(scope?: object): StarknetWallet | undefined;
/**
 * Outis for this site: the extension where it is installed, the sign.outis.xyz window otherwise.
 * Throws where `chainId` isn't a chain id.
 */
export declare function outisWallet(options: SessionOptions): SessionWallet;
/** The extension's object, as a SessionWallet: everything goes to the extension. */
export declare function extensionWallet(injected: StarknetWallet): SessionWallet;
/** Outis through the sign.outis.xyz window: signs messages for the account it signs in, nothing else. */
export declare function windowWallet(options: SessionOptions): SessionWallet;
export {};
