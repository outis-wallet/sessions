import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SIGN_ORIGIN } from "../src/protocol";
import { SignWindow } from "../src/signWindow";
import { DELEGATION, SEPOLIA, fakePage, settle, track } from "./fakes";

// An answer from the SDK's own window, at the sign origin, for an open id, always settles the
// request. A refusal written with `data: undefined` as an own key (as `{ code, message, data }` in
// TypeScript writes it when there is no data) reads as one without data; one the SDK can't read
// rejects with 163, as an unreadable `result` does, rather than leaving the request open.

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("a refusal the SDK can't read", () => {
  it("settles the request rather than leaving it open", async () => {
    const page = fakePage();
    const window = new SignWindow({ signOrigin: SIGN_ORIGIN, chainId: SEPOLIA, holdMs: 30_000 }, page.env);
    const signed = track(window.signTypedData(DELEGATION, null));
    const popup = page.popup();
    page.ready(popup);
    const id = popup.requests()[0]!.id;
    page.fail(popup, id, { code: 113, message: "An error occurred (USER_REFUSED_OP)", data: undefined });
    await settle();
    expect(signed.settled).toBe(true);
    expect(signed.error).toMatchObject({ code: expect.any(Number) });
  });
});
