import { SIGN_ORIGIN, type TypedDataJson } from "../src/protocol";
import type { Env, MessageLike, WindowLike } from "../src/signWindow";

// A page and its windows, without a browser: what the SDK opens, what it posts, and messages
// delivered to it as the browser would (each a structured clone, with the source and origin the
// browser sets).

export const SITE = "https://surround.gg";
export const SEPOLIA = "0x534e5f5345504f4c4941";
export const ALICE = `0x${"0a11ce".padStart(64, "0")}`;
export const BOB = `0x${"0b0b".padStart(64, "0")}`;

export class FakePopup implements WindowLike {
  closed = false;
  focused = 0;
  readonly posted: { message: unknown; target: string }[] = [];
  constructor(readonly url: string) {}
  postMessage(message: unknown, target: string) {
    this.posted.push({ message: structuredClone(message), target });
  }
  close() {
    this.closed = true;
  }
  focus() {
    this.focused++;
  }
  /** The requests posted to it, as the window would read them. */
  requests() {
    return this.posted.map(({ message }) => message as { id: string; method: string; [key: string]: unknown });
  }
}

export function fakePage({ blocked = false as boolean | "closed" } = {}) {
  const handlers: ((event: MessageLike) => void)[] = [];
  const popups: FakePopup[] = [];
  let next = 0;
  const env: Env = {
    origin: SITE,
    open(url) {
      if (blocked === true) return null;
      const popup = new FakePopup(url);
      if (blocked === "closed") popup.closed = true;
      popups.push(popup);
      return popup;
    },
    features: (width, height) => `popup,width=${width},height=${height}`,
    onMessage: (handler) => handlers.push(handler),
    randomId: () => (next++).toString(16).padStart(32, "0"),
  };
  const deliver = (source: unknown, origin: string, data: unknown) => {
    for (const handler of handlers) handler({ source, origin, data: structuredClone(data) });
  };
  return {
    env,
    popups,
    deliver,
    /** The last window opened. */
    popup: () => popups.at(-1)!,
    ready: (popup: FakePopup) => deliver(popup, SIGN_ORIGIN, { outis: "sessions", v: 1, kind: "ready" }),
    answer: (popup: FakePopup, id: string, result: unknown) => deliver(popup, SIGN_ORIGIN, { outis: "sessions", v: 1, kind: "response", id, result }),
    fail: (popup: FakePopup, id: string, error: unknown) => deliver(popup, SIGN_ORIGIN, { outis: "sessions", v: 1, kind: "response", id, error }),
  };
}

/** arbiter's Delegation, as Surround's sign-in asks for it (delegationTypedData). */
export const DELEGATION: TypedDataJson = {
  types: {
    StarknetDomain: [
      { name: "name", type: "shortstring" },
      { name: "version", type: "shortstring" },
      { name: "chainId", type: "shortstring" },
      { name: "revision", type: "shortstring" },
    ],
    Delegation: [
      { name: "game", type: "shortstring" },
      { name: "channel", type: "ContractAddress" },
      { name: "key", type: "felt" },
      { name: "expires_at", type: "timestamp" },
    ],
  },
  primaryType: "Delegation",
  domain: { name: "arbiter", version: "1", chainId: "SN_SEPOLIA", revision: "1" },
  message: { game: "go", channel: "0x123", key: "0x456", expires_at: "1762900000" },
};

/** Lets promise callbacks run. */
export const settle = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

/** Whether `promise` has settled yet, and how. */
export function track<T>(promise: Promise<T>) {
  const state: { settled: boolean; value?: T; error?: unknown } = { settled: false };
  promise.then(
    (value) => Object.assign(state, { settled: true, value }),
    (error) => Object.assign(state, { settled: true, error }),
  );
  return state;
}
