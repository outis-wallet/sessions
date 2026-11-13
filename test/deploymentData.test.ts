import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WalletRequestError } from "../src/errors";
import { MAX_CALLDATA_FELTS, SIGN_ORIGIN, connectResultOf, deploymentResultOf, parseRequest, signResultOf } from "../src/protocol";
import { SignWindow } from "../src/signWindow";
import { windowWallet } from "../src/wallet";
import { ALICE, BOB, DELEGATION, SEPOLIA, fakePage, settle, track } from "./fakes";

// `wallet_deploymentData` through the window: how the signed-in account is deployed, for the site
// that pays the deploy. What the window answers is read one way, counts only as an answer to this
// request, and only for the account the site asked under.

const PRIME = 2n ** 251n + 17n * 2n ** 192n + 1n;
const hex = (n: bigint) => `0x${n.toString(16)}`;
const ID = "ab".repeat(16);
const request = { outis: "sessions", v: 1, kind: "request", id: ID, method: "deploymentData", chainId: SEPOLIA };
/** An Outis account's deployment data: its class, salt 0, and the constructor's calldata (a Stark key as owner, no guardian). */
const data = (address = ALICE) => ({ address, class_hash: "0x1234abcd", salt: "0x0", calldata: ["0x0", "0x77", "0x1"], version: 1 });

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("the deployment data request", () => {
  it("is read through a structured clone, and names no account", () => {
    expect(parseRequest(structuredClone(request))).toEqual(request);
    expect(parseRequest({ ...request, account: ALICE })).toBeNull();
    expect(parseRequest({ ...request, account: null })).toBeNull();
    expect(parseRequest({ ...request, method: "deploymentdata" })).toBeNull();
    expect(parseRequest({ ...request, method: "wallet_deploymentData" })).toBeNull();
  });
});

describe("deploymentResultOf", () => {
  it("reads the account, its class, the salt, the calldata and Cairo version 1, through a structured clone", () => {
    expect(deploymentResultOf(structuredClone(data()))).toEqual(data());
    expect(deploymentResultOf({ ...data(), calldata: [] })).toEqual({ ...data(), calldata: [] });
    expect(deploymentResultOf({ ...data(), salt: hex(PRIME - 1n), calldata: Array(MAX_CALLDATA_FELTS).fill("0x1") })).toBeDefined();
  });

  it("gives back a copy with its own calldata", () => {
    const sent = data();
    const read = deploymentResultOf(sent)!;
    expect(read).not.toBe(sent);
    expect(read.calldata).not.toBe(sent.calldata);
  });

  it("refuses a key more or less", () => {
    for (const key of Object.keys(data())) {
      const { [key]: _, ...fewer } = data() as Record<string, unknown>;
      expect(deploymentResultOf(fewer), `without ${key}`).toBeUndefined();
    }
    expect(deploymentResultOf({ ...data(), sigdata: [] })).toBeUndefined();
    expect(deploymentResultOf({ ...data(), signature: ["0x1"] })).toBeUndefined();
  });

  it("refuses a value written another way, or that isn't one", () => {
    const holes = ["0x0", "0x1", "0x2"];
    delete holes[1];
    for (const change of [
      // An address is 64 digits, not 0, below 2^251; a felt has no leading zero and is below the prime.
      { address: "0xa11ce" },
      { address: ALICE.toUpperCase().replace("0X", "0x") },
      { address: `0x${"0".repeat(64)}` },
      { address: `0x${(2n ** 251n).toString(16).padStart(64, "0")}` },
      { address: null },
      { class_hash: "0x0" },
      { class_hash: "0x01234abcd" },
      { class_hash: "0x1234ABCD" },
      { class_hash: hex(PRIME) },
      { class_hash: 0x1234abcd },
      { salt: "0" },
      { salt: "0x00" },
      { salt: 0 },
      { salt: hex(PRIME) },
      { calldata: ["0x0", "0x077", "0x1"] },
      { calldata: ["0x0", 119, "0x1"] },
      { calldata: ["0x0", hex(PRIME), "0x1"] },
      { calldata: "0x0,0x77,0x1" },
      { calldata: { 0: "0x0", length: 1 } },
      { calldata: holes },
      { calldata: Object.assign(["0x0"], { more: "0x1" }) },
      { calldata: Array(MAX_CALLDATA_FELTS + 1).fill("0x1") },
      { calldata: null },
      { version: 0 },
      { version: 2 },
      { version: "1" },
      { version: true },
    ]) {
      expect(deploymentResultOf({ ...data(), ...change }), JSON.stringify(change)).toBeUndefined();
    }
    for (const value of [null, undefined, "0x1", [], [data()], new (class Data {})(), Object.create(data())]) expect(deploymentResultOf(value)).toBeUndefined();
  });

  it("is no other method's answer, nor is another's one (property)", () => {
    const felt = fc.bigInt({ min: 0n, max: PRIME - 1n }).map(hex);
    const address = fc.bigInt({ min: 1n, max: 2n ** 251n - 1n }).map((n) => `0x${n.toString(16).padStart(64, "0")}`);
    const deployment = fc.record({ address, class_hash: felt.filter((f) => f !== "0x0"), salt: felt, calldata: fc.array(felt, { maxLength: 8 }), version: fc.constant(1) });
    fc.assert(
      fc.property(deployment, fc.array(felt, { minLength: 1, maxLength: 4 }), fc.string(), (d, signature, key) => {
        expect(deploymentResultOf(structuredClone(d))).toEqual(d);
        expect(connectResultOf(d)).toBeUndefined();
        expect(signResultOf(d)).toBeUndefined();
        expect(deploymentResultOf({ address: d.address })).toBeUndefined();
        expect(deploymentResultOf({ address: d.address, signature })).toBeUndefined();
        if (!(key in d)) expect(deploymentResultOf({ ...d, [key]: 1 })).toBeUndefined();
      }),
    );
  });
});

describe("SignWindow.deploymentData", () => {
  const HOLD = 30_000;
  const signWindow = (page: ReturnType<typeof fakePage>) => new SignWindow({ signOrigin: SIGN_ORIGIN, chainId: SEPOLIA, holdMs: HOLD }, page.env);

  it("asks the window, only at the sign origin, and takes its answer", async () => {
    const page = fakePage();
    const asked = track(signWindow(page).deploymentData());
    const popup = page.popup();
    page.ready(popup);
    expect(popup.posted).toEqual([{ message: { ...request, id: "0".repeat(32) }, target: SIGN_ORIGIN }]);
    page.answer(popup, "0".repeat(32), data());
    await settle();
    expect(asked).toEqual({ settled: true, value: data() });
  });

  it("closes the window it opened for the answer", async () => {
    const page = fakePage();
    void signWindow(page).deploymentData();
    const popup = page.popup();
    page.ready(popup);
    page.answer(popup, popup.requests()[0]!.id, data());
    await settle();
    expect(popup.closed).toBe(true);
  });

  it("leaves a window held open after a sign-in open, for the signature that follows", async () => {
    const page = fakePage();
    const window = signWindow(page);
    void window.connect();
    const popup = page.popup();
    page.ready(popup);
    page.answer(popup, popup.requests()[0]!.id, { address: ALICE });
    await settle();
    vi.advanceTimersByTime(HOLD - 1);
    const asked = track(window.deploymentData());
    expect(page.popups).toHaveLength(1);
    page.answer(popup, popup.requests()[1]!.id, data());
    await settle();
    expect(asked.value).toEqual(data());
    // Held again from the answer, then closed.
    vi.advanceTimersByTime(HOLD - 1);
    expect(popup.closed).toBe(false);
    vi.advanceTimersByTime(1);
    expect(popup.closed).toBe(true);
  });

  it("refuses another method's answer, and gives its own to no other method", async () => {
    const page = fakePage();
    const window = signWindow(page);
    const connected = track(window.connect());
    const signed = track(window.signTypedData(DELEGATION, null));
    const first = track(window.deploymentData());
    const second = track(window.deploymentData());
    const popup = page.popup();
    page.ready(popup);
    const [connect, sign, one, two] = popup.requests();
    page.answer(popup, connect!.id, data());
    page.answer(popup, sign!.id, data());
    page.answer(popup, one!.id, { address: ALICE });
    page.answer(popup, two!.id, { address: ALICE, signature: ["0x1"] });
    await settle();
    for (const asked of [connected, signed, first, second]) {
      expect(asked.error).toBeInstanceOf(WalletRequestError);
      expect(asked.error).toMatchObject({ code: 163, data: "The Outis window answered something else" });
    }
  });

  it("takes an answer only from its own window, at the sign origin, for this id, once", async () => {
    const page = fakePage();
    const asked = track(signWindow(page).deploymentData());
    const popup = page.popup();
    page.ready(popup);
    const { id } = popup.requests()[0]!;
    page.deliver({}, SIGN_ORIGIN, { outis: "sessions", v: 1, kind: "response", id, result: data(BOB) });
    page.deliver(popup, "https://account.outis.xyz.evil.example", { outis: "sessions", v: 1, kind: "response", id, result: data(BOB) });
    page.answer(popup, "f".repeat(32), data(BOB));
    await settle();
    expect(asked.settled).toBe(false);
    page.answer(popup, id, data());
    page.answer(popup, id, data(BOB));
    await settle();
    expect(asked.value).toEqual(data());
  });

});

describe("wallet_deploymentData through the window", () => {
  function setup() {
    const page = fakePage();
    const wallet = windowWallet({ chainId: SEPOLIA, env: page.env, storage: null, extension: false });
    const changes: unknown[] = [];
    wallet.on("accountsChanged", (accounts) => changes.push(accounts));
    /** The site signed in as `address`, with the window still held open. */
    const signedIn = async (address: string) => {
      const accounts = wallet.request({ type: "wallet_requestAccounts" });
      const popup = page.popup();
      page.ready(popup);
      page.answer(popup, popup.requests().find((r) => r.method === "connect")!.id, { address });
      await accounts;
      return popup;
    };
    const ask = (params?: unknown) => track(wallet.request({ type: "wallet_deploymentData", params }));
    return { page, wallet, changes, signedIn, ask };
  }

  it("answers in the wallet API's shape, for the account the site knows, in the window it has open", async () => {
    const { page, signedIn, ask } = setup();
    const popup = await signedIn(ALICE);
    const asked = ask();
    expect(page.popups).toHaveLength(1);
    const sent = popup.requests().at(-1)!;
    expect(sent).toEqual({ outis: "sessions", v: 1, kind: "request", id: sent.id, method: "deploymentData", chainId: SEPOLIA });
    page.answer(popup, sent.id, data());
    await settle();
    expect(asked.value).toEqual({ address: ALICE, class_hash: "0x1234abcd", salt: "0x0", calldata: ["0x0", "0x77", "0x1"], version: 1 });
    expect(popup.closed).toBe(false);
  });

  it("opens the window in the call where it is closed, and closes it after", async () => {
    const { page, signedIn, ask } = setup();
    const first = await signedIn(ALICE);
    vi.advanceTimersByTime(30_000);
    expect(first.closed).toBe(true);
    const asked = ask({ api_version: "0.8" });
    expect(page.popups).toHaveLength(2);
    const popup = page.popup();
    page.ready(popup);
    page.answer(popup, popup.requests()[0]!.id, data());
    await settle();
    expect(asked.value).toEqual(data());
    expect(popup.closed).toBe(true);
  });

  it("refuses where no one is signed in, without a window: it signs no one in", async () => {
    const { page, ask, changes } = setup();
    const asked = ask();
    await settle();
    expect(asked.error).toBeInstanceOf(WalletRequestError);
    expect(asked.error).toMatchObject({ code: 116, message: expect.stringContaining("DEPLOYMENT_DATA_NOT_AVAILABLE") });
    expect(page.popups).toHaveLength(0);
    expect(changes).toEqual([]);
  });

  it("refuses a wallet API version the window doesn't answer for, and params it can't read, without a window", async () => {
    const { page, signedIn, ask } = setup();
    const popup = await signedIn(ALICE);
    const before = popup.requests().length;
    for (const params of [{ api_version: "0.6" }, { api_version: 8 }, { api_version: null }]) {
      const asked = ask(params);
      await settle();
      expect(asked.error, JSON.stringify(params)).toMatchObject({ code: 162 });
    }
    const thrower = ask({
      get api_version(): string {
        throw new Error("no");
      },
    });
    await settle();
    expect(thrower.error).toMatchObject({ code: 114 });
    expect(popup.requests()).toHaveLength(before);
    expect(page.popups).toHaveLength(1);
  });

  it("never hands over another account's data: the site is told of the account, and asks again", async () => {
    const { page, signedIn, ask, changes, wallet } = setup();
    const popup = await signedIn(ALICE);
    const asked = ask();
    page.answer(popup, popup.requests().at(-1)!.id, data(BOB));
    await settle();
    expect(asked.error).toMatchObject({ code: 163, data: "The user's Outis account changed" });
    expect(changes).toEqual([[ALICE], [BOB]]);
    await expect(wallet.request({ type: "wallet_requestAccounts", params: { silent_mode: true } })).resolves.toEqual([BOB]);
  });

  it("refuses an answer that arrives after the site's account changed, even one for the account it asked under", async () => {
    const { page, signedIn, ask, changes, wallet } = setup();
    const popup = await signedIn(ALICE);
    const asked = ask();
    const deployment = popup.requests().at(-1)!;
    // A signature by another account, answered first: the site now knows Bob.
    const signed = track(wallet.request({ type: "wallet_signTypedData", params: DELEGATION }));
    page.answer(popup, popup.requests().at(-1)!.id, { address: BOB, signature: ["0x5"] });
    await settle();
    expect(signed.error).toMatchObject({ code: 163 });
    page.answer(popup, deployment.id, data(ALICE));
    await settle();
    expect(asked.error).toMatchObject({ code: 163, data: "The user's Outis account changed" });
    expect(changes).toEqual([[ALICE], [BOB]]);
  });

  it("refuses an answer that arrives after the site signed out, and stays signed out", async () => {
    const { page, signedIn, ask, changes, wallet } = setup();
    const popup = await signedIn(ALICE);
    const asked = ask();
    const { id } = popup.requests().at(-1)!;
    wallet.forget();
    page.answer(popup, id, data());
    await settle();
    expect(asked.error).toMatchObject({ code: 113 });
    expect(changes).toEqual([[ALICE], []]);
  });

  it("refuses an answer in another shape, or another method's, with nothing remembered of it", async () => {
    const { page, signedIn, ask, changes } = setup();
    await signedIn(ALICE);
    for (const result of [{ address: BOB }, { address: BOB, signature: ["0x1"] }, { ...data(BOB), sigdata: [] }, { ...data(), version: 0 }, { ...data(), address: "0xa11ce" }]) {
      // Each refusal closes the window: the next request opens its own.
      const asked = ask();
      const popup = page.popup();
      page.ready(popup);
      page.answer(popup, popup.requests().at(-1)!.id, result);
      await settle();
      expect(asked.error, JSON.stringify(result)).toMatchObject({ code: 163, data: "The Outis window answered something else" });
      expect(popup.closed).toBe(true);
    }
    expect(changes).toEqual([[ALICE]]);
  });

  it("passes on the window's refusal", async () => {
    const { page, signedIn, ask } = setup();
    const popup = await signedIn(ALICE);
    const asked = ask();
    page.fail(popup, popup.requests().at(-1)!.id, { code: 113, message: "An error occurred (USER_REFUSED_OP)", data: "The user didn't sign in" });
    await settle();
    expect(asked.error).toMatchObject({ code: 113, data: "The user didn't sign in" });
  });
});
