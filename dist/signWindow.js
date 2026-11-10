import { WalletRequestError } from "./errors.js";
import { WINDOW_SIZE, PROTOCOL_VERSION, connectResultOf, deploymentResultOf, parseRequest, parseWindowMessage, responseIdOf, signResultOf, walletError, windowUrl, } from "./protocol.js";
/** The position of a `width` × `height` window centred over `over`, never above its top. */
export function centredOver(over, width, height) {
    return { left: Math.round(over.left + (over.width - width) / 2), top: Math.round(over.top + Math.max(0, (over.height - height) / 2)) };
}
export function browserEnv() {
    return {
        origin: window.location.origin,
        open: (url, features) => window.open(url, "_blank", features),
        features: (width, height) => {
            // Centred over the browser window, as Outis places its own windows.
            const { left, top } = centredOver({ left: window.screenX, top: window.screenY, width: window.outerWidth, height: window.outerHeight }, width, height);
            return `popup,width=${width},height=${height},left=${left},top=${top}`;
        },
        onMessage: (handler) => window.addEventListener("message", handler),
        randomId: () => [...crypto.getRandomValues(new Uint8Array(16))].map((byte) => byte.toString(16).padStart(2, "0")).join(""),
    };
}
/**
 * How long the window has to answer a request that asks nothing of the user (deployment data), once
 * it is the window's turn: it has the request and nothing that waits on the user is ahead of it.
 */
export const ANSWER_WITHIN_MS = 10_000;
const CLOSED = walletError("USER_REFUSED_OP", "The Outis window was closed");
const UNREADABLE = walletError("UNKNOWN_ERROR", "The Outis window answered something else");
const SILENT = walletError("UNKNOWN_ERROR", "The Outis window didn't answer");
export class SignWindow {
    #options;
    #env;
    #popup = null;
    #ready = false;
    #pending = new Map();
    #watch;
    #hold;
    #listening = false;
    /** A request answered since the window was last idle asked for it to close once nothing waits (a signature). */
    #closing = false;
    constructor(options, env) {
        // As the browser writes an origin, which answers are compared with: no path, no trailing slash.
        this.#options = { ...options, signOrigin: new URL(options.signOrigin).origin };
        this.#env = env;
    }
    /** Whether the window is open. */
    get isOpen() {
        return this.#popup !== null && !this.#popup.closed;
    }
    /**
     * Opens the window, or brings it forward where it is open. Call it in the click that leads to a
     * request when the request follows other work (a fetch): browsers block windows opened long after
     * the click. Throws where the browser blocks it.
     */
    open() {
        if (this.#popup && !this.#popup.closed) {
            this.#popup.focus();
            if (this.#pending.size === 0)
                this.#holdOpen();
            return;
        }
        this.#lost();
        const env = this.#environment();
        if (!this.#listening) {
            env.onMessage((event) => this.#onMessage(event));
            this.#listening = true;
        }
        const popup = env.open(windowUrl(this.#options.signOrigin, env.origin, this.#options.chainId), env.features(WINDOW_SIZE.width, WINDOW_SIZE.height));
        if (!popup || popup.closed)
            throw new WalletRequestError(walletError("UNKNOWN_ERROR", "The browser blocked the Outis window: allow pop-ups for this site"));
        this.#popup = popup;
        this.#watch = setInterval(() => {
            if (this.#popup?.closed)
                this.#lost();
        }, 250);
        this.#holdOpen();
    }
    /** Closes the window; whatever it still had open is refused. */
    close() {
        const popup = this.#popup;
        this.#lost();
        popup?.close();
    }
    /** Signs the user in, where the window has no one signed in, and answers with the account. The window then stays open a while for the next request. */
    connect() {
        return this.#request({ method: "connect" }, "hold", connectResultOf);
    }
    /** The account's signature over `typedData`, signed for `account` only where it is given. The window closes after. */
    signTypedData(typedData, account) {
        return this.#request({ method: "signTypedData", account, typedData }, "close", signResultOf);
    }
    /**
     * How the signed-in account is deployed, which the window answers without asking the user anything
     * (it refuses where no one is signed in there). The window is left as it was: held open where it
     * was open (after a sign-in, usually), closed where this request opened it; a signature asked for
     * beside it still closes the window, whichever is answered last. A window that doesn't answer
     * within `ANSWER_WITHIN_MS` of its turn (one that doesn't know the request) is a refusal (163),
     * not a wait without end.
     */
    deploymentData() {
        return this.#request({ method: "deploymentData" }, this.isOpen ? "hold" : "close", deploymentResultOf, ANSWER_WITHIN_MS);
    }
    #environment() {
        this.#env ??= browserEnv();
        return this.#env;
    }
    #request(fields, after, read, withinMs) {
        const env = this.#environment();
        const request = parseRequest({ outis: "sessions", v: PROTOCOL_VERSION, kind: "request", id: env.randomId(), chainId: this.#options.chainId, ...fields });
        if (!request || this.#pending.has(request.id)) {
            return Promise.reject(new WalletRequestError(walletError("INVALID_REQUEST_PAYLOAD", "Outis can't send this request to its window")));
        }
        try {
            this.open();
        }
        catch (error) {
            return Promise.reject(error);
        }
        return new Promise((resolve, reject) => {
            const take = (result) => {
                const value = read(result);
                if (value === undefined)
                    reject(new WalletRequestError(UNREADABLE));
                else
                    resolve(value);
                return value !== undefined;
            };
            this.#pending.set(request.id, { request, after, withinMs, resolve: take, reject });
            clearTimeout(this.#hold);
            if (this.#ready)
                this.#popup.postMessage(request, this.#options.signOrigin);
            this.#clock();
        });
    }
    /**
     * Starts the clock of each request the window answers by itself, once it is that request's turn:
     * the window is ready, and every request sent before it that may wait on the user (a sign-in, an
     * approval) is settled. The window serves requests in the order sent, so one behind a signature
     * isn't late while the user reads.
     */
    #clock() {
        if (!this.#ready)
            return;
        for (const [id, pending] of this.#pending) {
            if (pending.withinMs === undefined)
                return;
            pending.timer ??= setTimeout(() => {
                if (this.#pending.get(id) !== pending)
                    return;
                this.#pending.delete(id);
                pending.reject(new WalletRequestError(SILENT));
                this.#settled(pending.after, true);
            }, pending.withinMs);
        }
    }
    /** After a request is settled: with others waiting, on to the next; with none, the window closes or is held. */
    #settled(after, taken) {
        if (after === "close")
            this.#closing = true;
        if (this.#pending.size > 0)
            return this.#clock();
        // A refusal closes it too: no request follows a sign-in that didn't happen.
        if (this.#closing || !taken)
            this.close();
        else
            this.#holdOpen();
    }
    #onMessage(event) {
        if (this.#popup === null || event.source !== this.#popup || event.origin !== this.#options.signOrigin)
            return;
        const message = parseWindowMessage(event.data);
        if (message?.kind === "ready") {
            // The window loaded, or loaded again: it has none of the requests it was sent before.
            this.#ready = true;
            for (const pending of this.#pending.values())
                this.#popup.postMessage(pending.request, this.#options.signOrigin);
            this.#clock();
            return;
        }
        // An answer from its own window for an open id settles it, whether or not it can be read: one it
        // can't is refused, rather than left open with the window up.
        const id = message ? message.id : responseIdOf(event.data);
        const pending = id === undefined ? undefined : this.#pending.get(id);
        if (!pending)
            return;
        this.#pending.delete(id);
        clearTimeout(pending.timer);
        let taken = false;
        if (!message)
            pending.reject(new WalletRequestError(UNREADABLE));
        else if ("error" in message)
            pending.reject(new WalletRequestError(message.error));
        else
            taken = pending.resolve(message.result);
        this.#settled(pending.after, taken);
    }
    /** Keeps the window open `holdMs` more, then closes it if nothing is waiting. */
    #holdOpen() {
        clearTimeout(this.#hold);
        this.#hold = setTimeout(() => {
            if (this.#pending.size === 0)
                this.close();
        }, this.#options.holdMs);
    }
    /** Forgets the window, and refuses whatever it had open as closed. */
    #lost() {
        clearInterval(this.#watch);
        clearTimeout(this.#hold);
        this.#popup = null;
        this.#ready = false;
        this.#closing = false;
        const pending = [...this.#pending.values()];
        this.#pending.clear();
        for (const { reject, timer } of pending) {
            clearTimeout(timer);
            reject(new WalletRequestError(CLOSED));
        }
    }
}
