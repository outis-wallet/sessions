import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WalletRequestError } from "../src/errors";
import { SIGN_ORIGIN } from "../src/protocol";
import { SignWindow, browserEnv, centredOver } from "../src/signWindow";
import { ALICE, BOB, DELEGATION, SEPOLIA, SITE, fakePage, settle, track } from "./fakes";

const HOLD = 30_000;
const signWindow = (page: ReturnType<typeof fakePage>) => new SignWindow({ signOrigin: SIGN_ORIGIN, chainId: SEPOLIA, holdMs: HOLD }, page.env);

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("SignWindow", () => {
  it("opens the window at the sign origin, naming the site and chain, and sends nothing before it is ready", () => {
    const page = fakePage();
    void signWindow(page).connect();
    const popup = page.popup();
    const url = new URL(popup.url);
    expect(url.origin).toBe(SIGN_ORIGIN);
    expect(Object.fromEntries(url.searchParams)).toEqual({ v: "1", site: SITE, chain: SEPOLIA });
    expect(popup.posted).toEqual([]);
  });

  it("sends a request once the window is ready, only to the sign origin, and takes its answer", async () => {
    const page = fakePage();
    const connected = track(signWindow(page).connect());
    const popup = page.popup();
    page.ready(popup);
    expect(popup.posted).toEqual([
      { message: { outis: "sessions", v: 1, kind: "request", id: "0".repeat(32), method: "connect", chainId: SEPOLIA }, target: SIGN_ORIGIN },
    ]);
    page.answer(popup, "0".repeat(32), { address: ALICE });
    await settle();
    expect(connected).toEqual({ settled: true, value: { address: ALICE } });
  });

  it("sends at once to a window that is already ready", async () => {
    const page = fakePage();
    const window = signWindow(page);
    void window.connect();
    const popup = page.popup();
    page.ready(popup);
    void window.signTypedData(DELEGATION, null);
    expect(popup.requests().map((r) => r.method)).toEqual(["connect", "signTypedData"]);
    expect(page.popups).toHaveLength(1);
  });

  it("holds the window open after signing in, for the next request, then closes it", async () => {
    const page = fakePage();
    const window = signWindow(page);
    void window.connect();
    const popup = page.popup();
    page.ready(popup);
    page.answer(popup, popup.requests()[0]!.id, { address: ALICE });
    await settle();
    vi.advanceTimersByTime(HOLD - 1);
    expect(popup.closed).toBe(false);
    vi.advanceTimersByTime(1);
    expect(popup.closed).toBe(true);
    expect(window.isOpen).toBe(false);
  });

  it("closes the window once a signature is answered, and opens a new one for the next", async () => {
    const page = fakePage();
    const window = signWindow(page);
    const signed = track(window.signTypedData(DELEGATION, ALICE));
    const popup = page.popup();
    page.ready(popup);
    expect(popup.requests()[0]).toMatchObject({ method: "signTypedData", account: ALICE, typedData: DELEGATION, chainId: SEPOLIA });
    page.answer(popup, popup.requests()[0]!.id, { address: ALICE, signature: ["0x1", "0x2"] });
    await settle();
    expect(signed.value).toEqual({ address: ALICE, signature: ["0x1", "0x2"] });
    expect(popup.closed).toBe(true);
    void window.connect();
    expect(page.popups).toHaveLength(2);
  });

  it("keeps a window opened ahead for the request that follows, and brings it forward", async () => {
    const page = fakePage();
    const window = signWindow(page);
    window.open();
    vi.advanceTimersByTime(HOLD - 1);
    void window.signTypedData(DELEGATION, null);
    vi.advanceTimersByTime(HOLD * 2);
    expect(page.popups).toHaveLength(1);
    expect(page.popup().closed).toBe(false);
    expect(page.popup().focused).toBe(1);
  });

  it("closes a window opened ahead that no request follows", () => {
    const page = fakePage();
    signWindow(page).open();
    vi.advanceTimersByTime(HOLD);
    expect(page.popup().closed).toBe(true);
  });

  it("refuses what is open when the user closes the window", async () => {
    const page = fakePage();
    const signed = track(signWindow(page).signTypedData(DELEGATION, null));
    page.ready(page.popup());
    page.popup().closed = true;
    vi.advanceTimersByTime(250);
    await settle();
    expect(signed.error).toBeInstanceOf(WalletRequestError);
    expect(signed.error).toMatchObject({ code: 113, data: "The Outis window was closed" });
  });

  it("refuses where the browser blocks the window, opened or not", async () => {
    for (const blocked of [true, "closed"] as const) {
      const page = fakePage({ blocked });
      const connected = track(signWindow(page).connect());
      await settle();
      expect(connected.error).toMatchObject({ code: 163, data: expect.stringContaining("allow pop-ups") });
      expect(() => signWindow(page).open()).toThrow(WalletRequestError);
    }
  });

  it("refuses a request it can't send, without opening a window", async () => {
    const page = fakePage();
    const signed = track(signWindow(page).signTypedData({ ...DELEGATION, message: { n: 10n } } as never, null));
    await settle();
    expect(signed.error).toMatchObject({ code: 114 });
    expect(page.popups).toHaveLength(0);
  });

  it("sends what is open again when the window loads again", () => {
    const page = fakePage();
    const window = signWindow(page);
    void window.connect();
    void window.signTypedData(DELEGATION, null);
    const popup = page.popup();
    page.ready(popup);
    page.ready(popup);
    expect(popup.requests().map((r) => r.method)).toEqual(["connect", "signTypedData", "connect", "signTypedData"]);
  });

  it("gives each request its own answer, in whatever order they come", async () => {
    const page = fakePage();
    const window = signWindow(page);
    const connected = track(window.connect());
    const signed = track(window.signTypedData(DELEGATION, null));
    const popup = page.popup();
    page.ready(popup);
    const [connect, sign] = popup.requests();
    page.answer(popup, sign!.id, { address: BOB, signature: ["0x9"] });
    page.answer(popup, connect!.id, { address: ALICE });
    await settle();
    expect(connected.value).toEqual({ address: ALICE });
    expect(signed.value).toEqual({ address: BOB, signature: ["0x9"] });
  });

  it("passes on the window's refusal as it gave it", async () => {
    const page = fakePage();
    const signed = track(signWindow(page).signTypedData(DELEGATION, null));
    const popup = page.popup();
    page.ready(popup);
    page.fail(popup, popup.requests()[0]!.id, { code: 113, message: "An error occurred (USER_REFUSED_OP)", data: "Not this one" });
    await settle();
    expect(signed.error).toMatchObject({ code: 113, message: "An error occurred (USER_REFUSED_OP): Not this one", data: "Not this one" });
  });

  it("refuses a request whose own window answers it in a shape it can't read, rather than leaving it open", async () => {
    const page = fakePage();
    const signed = track(signWindow(page).signTypedData(DELEGATION, null));
    const popup = page.popup();
    page.ready(popup);
    page.fail(popup, popup.requests()[0]!.id, { code: 113, message: "An error occurred (USER_REFUSED_OP)", stack: "" });
    await settle();
    expect(signed.error).toMatchObject({ code: 163, data: "The Outis window answered something else" });
    expect(popup.closed).toBe(true);
  });

  it("closes the window on a refused sign-in, rather than holding it for a request that won't come", async () => {
    const page = fakePage();
    const connected = track(signWindow(page).connect());
    const popup = page.popup();
    page.ready(popup);
    page.fail(popup, popup.requests()[0]!.id, { code: 113, message: "An error occurred (USER_REFUSED_OP)" });
    await settle();
    expect(connected.error).toMatchObject({ code: 113 });
    expect(popup.closed).toBe(true);
  });

  it("refuses an answer that isn't what was asked for", async () => {
    const page = fakePage();
    const window = signWindow(page);
    const signed = track(window.signTypedData(DELEGATION, null));
    const connected = track(window.connect());
    const popup = page.popup();
    page.ready(popup);
    const [sign, connect] = popup.requests();
    // A connect's answer to the signature, and a signature's to the connect.
    page.answer(popup, sign!.id, { address: ALICE });
    page.answer(popup, connect!.id, { address: ALICE, signature: ["0x1"] });
    await settle();
    expect(signed.error).toMatchObject({ code: 163, data: "The Outis window answered something else" });
    expect(connected.error).toMatchObject({ code: 163, data: "The Outis window answered something else" });
  });

  it("ignores answers from another window, another origin, for another id, or a second time", async () => {
    const page = fakePage();
    const window = signWindow(page);
    const signed = track(window.signTypedData(DELEGATION, null));
    const connected = track(window.connect());
    const popup = page.popup();
    page.ready(popup);
    const [sign, connect] = popup.requests();
    const response = { outis: "sessions", v: 1, kind: "response", id: sign!.id, result: { address: BOB, signature: ["0x66"] } };
    page.deliver({}, SIGN_ORIGIN, response); // another window at the sign origin
    page.deliver(null, SIGN_ORIGIN, response);
    page.deliver(popup, "https://sign.outis.xyz.evil.example", response);
    page.deliver(popup, "http://sign.outis.xyz", response);
    page.deliver(popup, SITE, response);
    page.answer(popup, "f".repeat(32), { address: BOB, signature: ["0x66"] });
    await settle();
    expect(signed.settled).toBe(false);
    page.answer(popup, sign!.id, { address: ALICE, signature: ["0x1"] });
    page.answer(popup, sign!.id, { address: BOB, signature: ["0x66"] });
    await settle();
    expect(signed.value).toEqual({ address: ALICE, signature: ["0x1"] });
    expect(connected.settled).toBe(false);
    page.answer(popup, connect!.id, { address: ALICE });
    await settle();
    expect(connected.value).toEqual({ address: ALICE });
  });

  it("takes a sign origin written as an address, as the browser writes origins", async () => {
    const page = fakePage();
    const window = new SignWindow({ signOrigin: `${SIGN_ORIGIN}/`, chainId: SEPOLIA, holdMs: HOLD }, page.env);
    const connected = track(window.connect());
    const popup = page.popup();
    page.ready(popup);
    expect(popup.posted[0]!.target).toBe(SIGN_ORIGIN);
    page.answer(popup, popup.requests()[0]!.id, { address: ALICE });
    await settle();
    expect(connected.value).toEqual({ address: ALICE });
  });

  it("ignores a window it opened before, once it has another", async () => {
    const page = fakePage();
    const window = signWindow(page);
    void window.connect().catch(() => {});
    const first = page.popup();
    page.ready(first);
    first.closed = true;
    vi.advanceTimersByTime(250);
    const signed = track(window.signTypedData(DELEGATION, null));
    const second = page.popup();
    expect(second).not.toBe(first);
    page.ready(first);
    expect(second.posted).toEqual([]);
    page.answer(first, "1".padStart(32, "0"), { address: BOB, signature: ["0x66"] });
    await settle();
    expect(signed.settled).toBe(false);
  });

  it("refuses what is open when it is closed by the site", async () => {
    const page = fakePage();
    const window = signWindow(page);
    const connected = track(window.connect());
    window.close();
    await settle();
    expect(connected.error).toMatchObject({ code: 113 });
    expect(page.popup().closed).toBe(true);
  });

  it("settles a request only on its own window's answer at the sign origin (property)", async () => {
    const sources = ["popup", "other", "none"] as const;
    const origins = [SIGN_ORIGIN, "https://sign.outis.xyz.evil.example", "http://sign.outis.xyz", "null", SITE, "https://SIGN.outis.xyz"];
    const event = fc.record({
      source: fc.constantFrom(...sources),
      origin: fc.constantFrom(...origins),
      id: fc.oneof(fc.constant("own"), fc.stringMatching(/^[0-9a-f]{32}$/), fc.string()),
      body: fc.oneof(
        fc.constant({ result: { address: ALICE, signature: ["0x1"] } }),
        fc.constant({ error: { code: 113, message: "no" } }),
        fc.dictionary(fc.string(), fc.anything()),
      ),
      extra: fc.option(fc.dictionary(fc.string({ minLength: 1 }), fc.anything(), { minKeys: 1 }), { nil: undefined }),
    });
    await fc.assert(
      fc.asyncProperty(fc.array(event, { maxLength: 8 }), async (events) => {
        const page = fakePage();
        const signed = track(signWindow(page).signTypedData(DELEGATION, null));
        const popup = page.popup();
        page.ready(popup);
        const own = popup.requests()[0]!.id;
        let counts = false;
        for (const e of events) {
          const id = e.id === "own" ? own : e.id;
          const data = { ...e.extra, outis: "sessions", v: 1, kind: "response", id, ...e.body };
          page.deliver(e.source === "popup" ? popup : e.source === "other" ? {} : null, e.origin, data);
          // What may settle it: an answer (readable or not) from its own window, at the sign origin, for
          // its id. Anything else must not.
          const answer = data.outis === "sessions" && data.v === 1 && data.kind === "response";
          if (e.source === "popup" && e.origin === SIGN_ORIGIN && data.id === own && answer) counts = true;
        }
        await settle();
        if (!counts) expect(signed.settled).toBe(false);
      }),
    );
  });
});

describe("centredOver", () => {
  it("centres the window over the browser's, never above its top", () => {
    expect(centredOver({ left: 100, top: 50, width: 1200, height: 900 }, 400, 640)).toEqual({ left: 500, top: 180 });
    expect(centredOver({ left: 0, top: 20, width: 500, height: 300 }, 400, 640)).toEqual({ left: 50, top: 20 });
  });
});

describe("browserEnv", () => {
  it("opens the window with its opener kept, centred, and makes ids of 128 random bits", () => {
    const opened: unknown[][] = [];
    const listened: string[] = [];
    vi.stubGlobal("window", {
      location: { origin: SITE },
      screenX: 100,
      screenY: 50,
      outerWidth: 1200,
      outerHeight: 900,
      open: (...args: unknown[]) => (opened.push(args), null),
      addEventListener: (type: string) => listened.push(type),
    });
    try {
      const env = browserEnv();
      expect(env.origin).toBe(SITE);
      env.open("https://sign.outis.xyz/?v=1", env.features(400, 640));
      // noopener (or noreferrer, which implies it) would leave the window no opener to answer.
      expect(opened).toEqual([["https://sign.outis.xyz/?v=1", "_blank", "popup,width=400,height=640,left=500,top=180"]]);
      env.onMessage(() => {});
      expect(listened).toEqual(["message"]);
      const ids = new Set(Array.from({ length: 100 }, () => env.randomId()));
      expect(ids.size).toBe(100);
      for (const id of ids) expect(id).toMatch(/^[0-9a-f]{32}$/);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
