import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WalletRequestError } from "../src/errors";
import { EXTENSION_GLOBAL, ICON, SESSIONS_VERSION, findExtension, outisWallet, windowWallet, type StarknetWallet, type StorageLike } from "../src/wallet";
import { ALICE, BOB, DELEGATION, SEPOLIA, fakePage, settle, track } from "./fakes";

class MemoryStorage implements StorageLike {
  readonly items = new Map<string, string>();
  getItem(key: string) {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.items.set(key, value);
  }
  removeItem(key: string) {
    this.items.delete(key);
  }
}

function setup(options: { storage?: StorageLike | null } = {}) {
  const page = fakePage();
  const storage = options.storage === undefined ? new MemoryStorage() : options.storage;
  const wallet = windowWallet({ chainId: "0x534E5F5345504F4C4941", env: page.env, storage, extension: false });
  const changes: unknown[] = [];
  wallet.on("accountsChanged", (accounts) => changes.push(accounts));
  /** The window signs the user in as `address`, answering the first connect it was sent. */
  const signIn = (address: string) => {
    const popup = page.popup();
    page.ready(popup);
    const request = popup.requests().find((r) => r.method === "connect")!;
    page.answer(popup, request.id, { address });
  };
  return { page, storage, wallet, changes, signIn };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  delete (globalThis as Record<string, unknown>)[EXTENSION_GLOBAL];
});

describe("outisWallet", () => {
  const injected = (): StarknetWallet => ({
    id: "outis",
    name: "Outis",
    version: "0.2.4",
    icon: ICON,
    request: vi.fn(async () => "from the extension"),
    on: vi.fn(),
    off: vi.fn(),
  });

  it("is the extension where it is installed, every request going to it, transactions too", async () => {
    const extension = injected();
    (globalThis as Record<string, unknown>)[EXTENSION_GLOBAL] = extension;
    const wallet = outisWallet({ chainId: SEPOLIA });
    expect(wallet.kind).toBe("extension");
    expect(wallet.version).toBe("0.2.4");
    const call = { type: "wallet_addInvokeTransaction", params: { calls: [] } };
    await expect(wallet.request(call)).resolves.toBe("from the extension");
    expect(extension.request).toHaveBeenCalledWith(call);
    const handler = () => {};
    wallet.on("accountsChanged", handler);
    wallet.off("accountsChanged", handler);
    expect(extension.on).toHaveBeenCalledWith("accountsChanged", handler);
    expect(extension.off).toHaveBeenCalledWith("accountsChanged", handler);
    expect(() => {
      wallet.open();
      wallet.forget();
    }).not.toThrow();
  });

  it("is the window where the extension isn't installed, or isn't wanted, or something else sits where it would", () => {
    expect(outisWallet({ chainId: SEPOLIA }).kind).toBe("window");
    (globalThis as Record<string, unknown>)[EXTENSION_GLOBAL] = injected();
    expect(outisWallet({ chainId: SEPOLIA, extension: false }).kind).toBe("window");
    (globalThis as Record<string, unknown>)[EXTENSION_GLOBAL] = { ...injected(), id: "argentX" };
    expect(outisWallet({ chainId: SEPOLIA }).kind).toBe("window");
    (globalThis as Record<string, unknown>)[EXTENSION_GLOBAL] = { id: "outis" };
    expect(findExtension()).toBeUndefined();
    // Only a whole wallet object is taken: one whose events would throw at the site's first `on` isn't.
    (globalThis as Record<string, unknown>)[EXTENSION_GLOBAL] = { id: "outis", request: async () => null };
    expect(findExtension()).toBeUndefined();
    expect(outisWallet({ chainId: SEPOLIA }).kind).toBe("window");
    const { name: _, ...nameless } = injected();
    (globalThis as Record<string, unknown>)[EXTENSION_GLOBAL] = nameless;
    expect(findExtension()).toBeUndefined();
    const throwing = Object.defineProperty({}, EXTENSION_GLOBAL, {
      get() {
        throw new Error("no");
      },
    });
    expect(findExtension(throwing)).toBeUndefined();
  });

  it("refuses a chain id that isn't one, extension or not", () => {
    expect(() => windowWallet({ chainId: "SN_SEPOLIA" })).toThrow(TypeError);
    (globalThis as Record<string, unknown>)[EXTENSION_GLOBAL] = injected();
    expect(() => outisWallet({ chainId: "SN_SEPOLIA" })).toThrow(TypeError);
  });

  it("takes a sign origin written as an address, as the browser writes origins", async () => {
    const page = fakePage();
    const wallet = windowWallet({ chainId: SEPOLIA, signOrigin: "https://account.outis.xyz/", env: page.env, storage: null });
    const accounts = track(wallet.request({ type: "wallet_requestAccounts" }));
    expect(new URL(page.popup().url).origin).toBe("https://account.outis.xyz");
    page.ready(page.popup());
    page.answer(page.popup(), page.popup().requests()[0]!.id, { address: ALICE });
    await settle();
    expect(accounts.value).toEqual([ALICE]);
    expect(() => windowWallet({ chainId: SEPOLIA, signOrigin: "account.outis.xyz" })).toThrow(TypeError);
  });

  it("looks like the extension's own object to a site", () => {
    // The extension's own values, as its object carries them (2026-11-09): a change here is one the
    // extension makes too.
    const wallet = windowWallet({ chainId: SEPOLIA, storage: null });
    expect(EXTENSION_GLOBAL).toBe("starknet_outis");
    expect([wallet.id, wallet.name]).toEqual(["outis", "Outis"]);
    expect(wallet.icon).toEqual(ICON);
    expect(Object.keys(ICON)).toEqual(["dark", "light"]);
    expect(createHash("sha256").update(JSON.stringify(ICON)).digest("hex")).toBe("bacd5fcc3d643fcc4065abe8b7e378e95d98da931f53c33937be28cc0d4c0665");
    const error = new WalletRequestError({ code: 113, message: "An error occurred (USER_REFUSED_OP)", data: "no" });
    expect([error.name, error.message, error.code, error.data]).toEqual(["WalletRequestError", "An error occurred (USER_REFUSED_OP): no", 113, "no"]);
  });

  it("names its package's version", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(SESSIONS_VERSION).toBe(pkg.version);
  });
});

describe("windowWallet", () => {
  it("answers what it knows without a window", async () => {
    const { wallet, page } = setup();
    await expect(wallet.request({ type: "wallet_requestChainId" })).resolves.toBe(SEPOLIA);
    await expect(wallet.request({ type: "wallet_getPermissions" })).resolves.toEqual([]);
    await expect(wallet.request({ type: "wallet_supportedWalletApi" })).resolves.toContain("0.8");
    await expect(wallet.request({ type: "wallet_supportedSpecs" })).resolves.toContain("0.9");
    await expect(wallet.request({ type: "wallet_switchStarknetChain", params: { chainId: SEPOLIA.toUpperCase().replace("0X", "0x") } })).resolves.toBe(true);
    await expect(wallet.request({ type: "wallet_switchStarknetChain", params: { chainId: "0x534e5f4d41494e" } })).rejects.toMatchObject({ code: 112 });
    await expect(wallet.request({ type: "wallet_switchStarknetChain", params: {} })).rejects.toMatchObject({ code: 114 });
    await expect(wallet.request({ type: "wallet_requestAccounts", params: { silent_mode: true } })).resolves.toEqual([]);
    expect(page.popups).toHaveLength(0);
  });

  it("refuses transactions and anything else but messages, without a window", async () => {
    const { wallet, page } = setup();
    for (const type of ["wallet_addInvokeTransaction", "wallet_addDeclareTransaction", "wallet_watchAsset", "wallet_addStarknetChain", "starknet_signTransaction"]) {
      const error = await wallet.request({ type, params: {} }).catch((e) => e);
      expect(error, type).toBeInstanceOf(WalletRequestError);
      expect(error).toMatchObject({ code: 163, data: `Outis signs only messages here: ${type} needs the Outis extension` });
    }
    await expect(wallet.request({} as never)).rejects.toMatchObject({ code: 114 });
    await expect(wallet.request(undefined as never)).rejects.toMatchObject({ code: 114 });
    expect(page.popups).toHaveLength(0);
  });

  it("opens the window in the call that asks for the account, as a click needs, and remembers the account", async () => {
    const { wallet, page, storage, changes, signIn } = setup();
    const accounts = track(wallet.request({ type: "wallet_requestAccounts" }));
    expect(page.popups).toHaveLength(1);
    signIn(ALICE);
    await settle();
    expect(accounts.value).toEqual([ALICE]);
    expect(changes).toEqual([[ALICE]]);
    expect([...(storage as MemoryStorage).items.values()]).toEqual([ALICE]);
    await expect(wallet.request({ type: "wallet_requestAccounts" })).resolves.toEqual([ALICE]);
    await expect(wallet.request({ type: "wallet_requestAccounts", params: { silent_mode: true } })).resolves.toEqual([ALICE]);
    await expect(wallet.request({ type: "wallet_getPermissions" })).resolves.toEqual(["accounts"]);
    expect(page.popups).toHaveLength(1);
  });

  it("asks the window once for two requests for the account at a time", async () => {
    const { wallet, page, signIn } = setup();
    const first = track(wallet.request({ type: "wallet_requestAccounts" }));
    const second = track(wallet.request({ type: "wallet_requestAccounts" }));
    signIn(ALICE);
    await settle();
    expect(page.popup().requests()).toHaveLength(1);
    expect([first.value, second.value]).toEqual([[ALICE], [ALICE]]);
  });

  it("asks the window again after a sign-in that failed", async () => {
    const { wallet, page } = setup();
    const first = track(wallet.request({ type: "wallet_requestAccounts" }));
    page.popup().closed = true;
    vi.advanceTimersByTime(250);
    await settle();
    expect(first.error).toMatchObject({ code: 113 });
    void wallet.request({ type: "wallet_requestAccounts" });
    expect(page.popups).toHaveLength(2);
  });

  it("opens the window in the call that asks for a signature, and sends the message as JSON, for the account it knows", async () => {
    const { wallet, page, signIn } = setup();
    void wallet.request({ type: "wallet_requestAccounts" });
    signIn(ALICE);
    await settle();
    page.popup().close();
    vi.advanceTimersByTime(250);
    const signed = track(wallet.request({ type: "wallet_signTypedData", params: { ...DELEGATION, message: { ...DELEGATION.message, dropped: undefined } } }));
    expect(page.popups).toHaveLength(2);
    const popup = page.popup();
    page.ready(popup);
    const [request] = popup.requests();
    expect(request).toMatchObject({ method: "signTypedData", account: ALICE, typedData: DELEGATION });
    page.answer(popup, request!.id, { address: ALICE, signature: ["0x1", "0x2"] });
    await settle();
    expect(signed.value).toEqual(["0x1", "0x2"]);
  });

  it("refuses a message to sign that isn't one, without a window", async () => {
    const { wallet, page } = setup();
    for (const params of [{ ...DELEGATION, message: { n: 1n } }, { ...DELEGATION, extra: 1 }, "message", undefined]) {
      await expect(wallet.request({ type: "wallet_signTypedData", params })).rejects.toMatchObject({ code: 114 });
    }
    for (const api_version of ["0.6", "1.0", 10, null]) {
      await expect(wallet.request({ type: "wallet_signTypedData", params: { ...DELEGATION, api_version } })).rejects.toMatchObject({ code: 162 });
    }
    expect(page.popups).toHaveLength(0);
  });

  it("remembers the account that signs where it knew none", async () => {
    const { wallet, page, changes } = setup();
    const signed = track(wallet.request({ type: "wallet_signTypedData", params: DELEGATION }));
    const popup = page.popup();
    page.ready(popup);
    expect(popup.requests()[0]).toMatchObject({ account: null });
    page.answer(popup, popup.requests()[0]!.id, { address: BOB, signature: ["0x5"] });
    await settle();
    expect(signed.value).toEqual(["0x5"]);
    expect(changes).toEqual([[BOB]]);
    await expect(wallet.request({ type: "wallet_requestAccounts", params: { silent_mode: true } })).resolves.toEqual([BOB]);
  });

  it("refuses a signature by another account than the site knows, and tells the site of the change", async () => {
    const { wallet, page, changes, signIn } = setup();
    void wallet.request({ type: "wallet_requestAccounts" });
    signIn(ALICE);
    await settle();
    const signed = track(wallet.request({ type: "wallet_signTypedData", params: DELEGATION }));
    const popup = page.popup();
    const request = popup.requests().at(-1)!;
    expect(request).toMatchObject({ method: "signTypedData", account: ALICE });
    page.answer(popup, request.id, { address: BOB, signature: ["0x5"] });
    await settle();
    expect(signed.error).toMatchObject({ code: 163, data: "The user's Outis account changed" });
    expect(changes).toEqual([[ALICE], [BOB]]);
    await expect(wallet.request({ type: "wallet_requestAccounts" })).resolves.toEqual([BOB]);
  });

  it("forgets the account and closes the window on signing out", async () => {
    const { wallet, page, changes, signIn } = setup();
    void wallet.request({ type: "wallet_requestAccounts" });
    signIn(ALICE);
    await settle();
    wallet.forget();
    expect(page.popup().closed).toBe(true);
    expect(changes).toEqual([[ALICE], []]);
    await expect(wallet.request({ type: "wallet_requestAccounts", params: { silent_mode: true } })).resolves.toEqual([]);
    wallet.forget();
    expect(changes).toHaveLength(2);
  });

  it("signs in again in the same handler that signed out, with a sign-in still open", async () => {
    const { wallet, page } = setup();
    const first = track(wallet.request({ type: "wallet_requestAccounts" }));
    wallet.forget();
    const second = track(wallet.request({ type: "wallet_requestAccounts" }));
    expect(page.popups).toHaveLength(2);
    await settle();
    expect(first.error).toMatchObject({ code: 113 });
    expect(second.settled).toBe(false);
    // The refused sign-in, settling, leaves the new one alone: a third request shares it.
    const third = track(wallet.request({ type: "wallet_requestAccounts" }));
    expect(page.popups).toHaveLength(2);
    page.ready(page.popup());
    page.answer(page.popup(), page.popup().requests()[0]!.id, { address: ALICE });
    await settle();
    expect([second.value, third.value]).toEqual([[ALICE], [ALICE]]);
  });

  it("takes only its own events' names", () => {
    const { wallet } = setup();
    for (const event of ["__proto__", "constructor", "toString"]) {
      expect(() => wallet.on(event as never, () => {})).not.toThrow();
      expect(() => wallet.off(event as never, () => {})).not.toThrow();
    }
  });

  it("opens the window ahead, for a request that follows a fetch", () => {
    const { wallet, page } = setup();
    wallet.open();
    expect(page.popups).toHaveLength(1);
    void wallet.request({ type: "wallet_signTypedData", params: DELEGATION });
    page.ready(page.popup());
    expect(page.popups).toHaveLength(1);
    expect(page.popup().requests()).toMatchObject([{ method: "signTypedData" }]);
  });

  it("works with no storage, or storage that throws, or holds something else", async () => {
    const throwing: StorageLike = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
      removeItem: () => {
        throw new Error("denied");
      },
    };
    for (const storage of [null, throwing]) {
      const { wallet, signIn } = setup({ storage });
      const accounts = track(wallet.request({ type: "wallet_requestAccounts" }));
      signIn(ALICE);
      await settle();
      expect(accounts.value).toEqual([ALICE]);
      // Kept for this page, in memory: a storage that fails never drops an account given to the site.
      await expect(wallet.request({ type: "wallet_requestAccounts", params: { silent_mode: true } })).resolves.toEqual([ALICE]);
    }
    // A storage that reads but won't write (a full one): the account is kept in memory all the same.
    const full = new MemoryStorage();
    full.setItem = () => {
      throw new Error("QuotaExceededError");
    };
    const kept = setup({ storage: full });
    void kept.wallet.request({ type: "wallet_requestAccounts" });
    kept.signIn(ALICE);
    await settle();
    await expect(kept.wallet.request({ type: "wallet_requestAccounts", params: { silent_mode: true } })).resolves.toEqual([ALICE]);
    const planted = new MemoryStorage();
    const { wallet } = setup({ storage: planted });
    planted.setItem(`outis-sessions:https://account.outis.xyz:${SEPOLIA}:account`, "0xA11CE");
    await expect(wallet.request({ type: "wallet_requestAccounts", params: { silent_mode: true } })).resolves.toEqual([]);
  });

  it("keeps calling the site's handlers when one throws", async () => {
    const { wallet, signIn, changes } = setup();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    wallet.on("accountsChanged", () => {
      throw new Error("handler");
    });
    const after: unknown[] = [];
    wallet.on("accountsChanged", (accounts) => after.push(accounts));
    void wallet.request({ type: "wallet_requestAccounts" });
    signIn(ALICE);
    await settle();
    expect(changes).toEqual([[ALICE]]);
    expect(after).toEqual([[ALICE]]);
    expect(error).toHaveBeenCalledOnce();
    error.mockRestore();
  });
});
