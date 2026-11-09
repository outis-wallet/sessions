import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { windowWallet } from "../src/wallet";
import { ALICE, fakePage, settle, track } from "./fakes";

// `forget()` while a sign-in is open, then `wallet_requestAccounts` in the same turn (a "Switch
// account" button: `outis.forget(); await outis.request({ type: "wallet_requestAccounts" })`). The
// second request opens the window again, rather than getting the first sign-in's refusal (113 "The
// Outis window was closed") with no window open.

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("forget then connect in the same turn", () => {
  it("opens the window again for a sign-in asked right after forget()", async () => {
    const page = fakePage();
    const wallet = windowWallet({ chainId: "0x534e5f5345504f4c4941", env: page.env, storage: null, extension: false });
    const first = track(wallet.request({ type: "wallet_requestAccounts" }));
    expect(page.popups).toHaveLength(1);
    wallet.forget();
    const second = track(wallet.request({ type: "wallet_requestAccounts" }));
    await settle();
    expect(first.error).toMatchObject({ code: 113 });
    // The second sign-in is its own: a new window, not the first one's refusal.
    expect(page.popups).toHaveLength(2);
    expect(second.settled).toBe(false);
    const popup = page.popup();
    page.ready(popup);
    page.answer(popup, popup.requests()[0]!.id, { address: ALICE });
    await settle();
    expect(second.value).toEqual([ALICE]);
  });
});
