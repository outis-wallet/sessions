import { WalletRequestError } from "./errors.js";
import { SIGN_ORIGIN, chainIdOf, isAddress, typedDataOf, walletError, type ErrorPayload } from "./protocol.js";
import { SignWindow, type Env } from "./signWindow.js";

// The object a site talks to: the standard Starknet wallet object (StarknetWindowObject in
// @starknet-io/types-js), the shape the Outis extension puts in every page as `window.starknet_outis`.
// get-starknet takes it as it is (`new StarknetInjectedWallet(wallet)` for its wallet standard).
//
// Where the extension is installed, it is the extension's own object: the whole wallet, its reviews
// and its transactions. Otherwise the sign.outis.xyz window stands behind it, and that signs messages
// only: the kinds its list holds for the site, never a transaction. Moving funds needs the extension.

export const SESSIONS_VERSION = "0.1.0";
/** The extension's object, where it puts it: `window.starknet_outis`. */
export const EXTENSION_GLOBAL = "starknet_outis";

export type WalletEvent = "accountsChanged" | "networkChanged";
type Handler = (...args: unknown[]) => void;

/** The standard Starknet wallet object, as Outis gives it. */
export type StarknetWallet = {
  id: string;
  name: string;
  version: string;
  icon: string | { dark: string; light: string };
  request(call: { type: string; params?: unknown }): Promise<unknown>;
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

/** The wallet API versions the window answers for (signing only), and the node spec versions. */
const WINDOW_WALLET_API = ["0.7", "0.8", "0.9", "0.10"];
const WINDOW_SPECS = ["0.9", "0.10"];

// The mark in a 500 × 500 box, and the icons the extension's object carries.
const MARK =
  "M499.2 230H407.74C278.77 230 250 98.37 250 97.37C250 98.37 221.23 230 92.26 230H0.8A250 250 0 0 1 499.2 230ZM499.2 270A250 250 0 0 1 0.8 270H92.26C221.23 270 250 401.63 250 402.63C250 401.63 278.77 270 407.74 270Z";
const svg = (body: string) => `data:image/svg+xml;base64,${btoa(`<svg xmlns="http://www.w3.org/2000/svg" ${body}</svg>`)}`;
export const ICON = {
  dark: svg(`viewBox="-44 -44 588 588"><title>Outis</title><path fill="#C7D7BA" d="${MARK}"/>`),
  light: svg(
    `viewBox="0 0 512 512"><title>Outis</title><rect width="512" height="512" rx="114" fill="#253828"/>` +
      `<path fill="#C7D7BA" transform="translate(82 82) scale(.696)" d="${MARK}"/>`,
  ),
};

/** The extension's object in this page, if it is installed. */
export function findExtension(scope: object = globalThis): StarknetWallet | undefined {
  // The whole object get-starknet would take (an id, a name, a version, request, on, off); a getter
  // that throws counts as none.
  try {
    const injected = (scope as Record<string, unknown>)[EXTENSION_GLOBAL] as Partial<StarknetWallet> | undefined;
    if (!injected || injected.id !== "outis" || typeof injected.name !== "string" || typeof injected.version !== "string") return undefined;
    if (typeof injected.request !== "function" || typeof injected.on !== "function" || typeof injected.off !== "function") return undefined;
    return injected as StarknetWallet;
  } catch {
    return undefined;
  }
}

/**
 * Outis for this site: the extension where it is installed, the sign.outis.xyz window otherwise.
 * Throws where `chainId` isn't a chain id.
 */
export function outisWallet(options: SessionOptions): SessionWallet {
  if (!chainIdOf(options.chainId)) throw new TypeError(`Not a chain id: ${options.chainId}`);
  const extension = options.extension === false ? undefined : findExtension();
  return extension ? extensionWallet(extension) : windowWallet(options);
}

/** The extension's object, as a SessionWallet: everything goes to the extension. */
export function extensionWallet(injected: StarknetWallet): SessionWallet {
  return {
    id: injected.id,
    name: injected.name,
    version: injected.version,
    icon: injected.icon,
    kind: "extension",
    request: (call) => injected.request(call),
    on: (event, handler) => injected.on(event, handler),
    off: (event, handler) => injected.off(event, handler),
    open() {},
    forget() {},
  };
}

const refuse = (payload: ErrorPayload) => Promise.reject(new WalletRequestError(payload));

/** Outis through the sign.outis.xyz window: signs messages for the account it signs in, nothing else. */
export function windowWallet(options: SessionOptions): SessionWallet {
  const chainId = chainIdOf(options.chainId);
  if (!chainId) throw new TypeError(`Not a chain id: ${options.chainId}`);
  // As the browser writes an origin, which is what answers are compared with: no path, no trailing slash.
  const signOrigin = new URL(options.signOrigin ?? SIGN_ORIGIN).origin;
  const signWindow = new SignWindow({ signOrigin, chainId, holdMs: options.holdMs ?? 30_000 }, options.env);
  const storage = options.storage === undefined ? pageStorage() : options.storage;
  const key = `outis-sessions:${signOrigin}:${chainId}:account`;
  const handlers: Record<WalletEvent, Set<Handler>> = { accountsChanged: new Set(), networkChanged: new Set() };

  const emit = (event: WalletEvent, ...args: unknown[]) => {
    for (const handler of handlers[event]) {
      try {
        handler(...args);
      } catch (error) {
        console.error("Outis: a wallet event handler threw", error);
      }
    }
  };
  // The account the site knows the user by: in storage, which the site's other tabs share, and in
  // memory where storage can't be read or written, so an account just given to the site is never
  // dropped by a storage that fails.
  let usable = storage !== null;
  let memory: string | null = null;
  const remembered = (): string | null => {
    if (usable) {
      try {
        const address = storage!.getItem(key);
        return isAddress(address) ? address : null;
      } catch {
        usable = false;
      }
    }
    return memory;
  };
  /** What the site was last told the account is (`accountsChanged`). */
  let told = remembered();
  /** Tells the site the account is `address`, where that isn't what it was last told. */
  const tell = (address: string | null) => {
    if (address === told) return;
    told = address;
    emit("accountsChanged", address === null ? [] : [address]);
  };
  /** Remembers `address` as the user's account, and tells the site where it changed. */
  const remember = (address: string | null) => {
    memory = address;
    if (usable) {
      try {
        if (address === null) storage!.removeItem(key);
        else storage!.setItem(key, address);
      } catch {
        usable = false;
      }
    }
    tell(address);
  };
  const changed = () => refuse(walletError("UNKNOWN_ERROR", "The user's Outis account changed"));

  // Each answer counts only for the account it was asked under: where the account changed while
  // the window worked (another request's answer, `forget()`, another tab), the answer is refused
  // and the site told of the account as it now is.

  // Two requests for the account while the window signs the user in share its one answer.
  let connecting: Promise<string> | null = null;
  const connect = () => {
    if (!connecting) {
      const before = remembered();
      const asked: Promise<string> = signWindow
        .connect()
        .then(({ address }) => {
          const now = remembered();
          if (now !== before) {
            tell(now);
            return changed();
          }
          remember(address);
          return address;
        })
        .finally(() => {
          // Not one asked for after a `forget()` dropped this one.
          if (connecting === asked) connecting = null;
        });
      connecting = asked;
    }
    return connecting;
  };

  const signTypedData = async (params: unknown) => {
    let copy: unknown;
    try {
      copy = JSON.parse(JSON.stringify(params));
    } catch {
      return refuse(walletError("INVALID_REQUEST_PAYLOAD", "The message to sign isn't JSON"));
    }
    // The wallet API's version, which a site may name beside the message: not part of what is signed.
    if (copy !== null && typeof copy === "object" && "api_version" in copy) {
      const { api_version, ...message } = copy as Record<string, unknown>;
      if (typeof api_version !== "string" || !WINDOW_WALLET_API.includes(api_version)) {
        return refuse(walletError("API_VERSION_NOT_SUPPORTED", `Outis's window doesn't answer wallet API ${String(api_version)}`));
      }
      copy = message;
    }
    const typedData = typedDataOf(copy);
    if (!typedData) return refuse(walletError("INVALID_REQUEST_PAYLOAD", "That isn't a message to sign"));
    const account = remembered();
    const { address, signature } = await signWindow.signTypedData(typedData, account);
    const now = remembered();
    if (now !== account) {
      tell(now);
      return changed();
    }
    // Both written the protocol's one way (`isAddress`), so equal as strings where equal at all.
    if (address !== account) {
      // An account the site knew none for, or another than it knows: the site hears of it, and in
      // the second case asks again.
      remember(address);
      if (account !== null) return changed();
    }
    return signature;
  };

  return {
    id: "outis",
    name: "Outis",
    version: SESSIONS_VERSION,
    icon: ICON,
    kind: "window",
    async request(call) {
      switch (call?.type) {
        case "wallet_supportedWalletApi":
          return WINDOW_WALLET_API;
        case "wallet_supportedSpecs":
          return WINDOW_SPECS;
        case "wallet_getPermissions":
          return remembered() ? ["accounts"] : [];
        case "wallet_requestChainId":
          return chainId;
        case "wallet_switchStarknetChain": {
          const asked = chainIdOf((call.params as { chainId?: unknown } | undefined)?.chainId);
          if (!asked) return refuse(walletError("INVALID_REQUEST_PAYLOAD", "The request has no chain id"));
          return asked === chainId ? true : refuse(walletError("UNLISTED_NETWORK", "This site plays on another network"));
        }
        case "wallet_requestAccounts": {
          const address = remembered();
          if (address) return [address];
          if ((call.params as { silent_mode?: unknown } | undefined)?.silent_mode === true) return [];
          return [await connect()];
        }
        case "wallet_signTypedData":
          return signTypedData(call.params);
        default:
          if (typeof call?.type !== "string") return refuse(walletError("INVALID_REQUEST_PAYLOAD"));
          return refuse(walletError("UNKNOWN_ERROR", `Outis signs only messages here: ${call.type} needs the Outis extension`));
      }
    },
    on(event, handler) {
      if (Object.hasOwn(handlers, event)) handlers[event].add(handler);
    },
    off(event, handler) {
      if (Object.hasOwn(handlers, event)) handlers[event].delete(handler);
    },
    open: () => signWindow.open(),
    forget() {
      // The sign-in still open is refused as the window closes; a sign-in asked for next starts anew.
      connecting = null;
      signWindow.close();
      remember(null);
    },
  };
}

function pageStorage(): StorageLike | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}
