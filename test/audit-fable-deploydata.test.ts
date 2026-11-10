import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { windowWallet } from "../src/wallet";
import { ALICE, DELEGATION, SEPOLIA, fakePage, settle, track } from "./fakes";

// Fable's review of the deployment data change (2026-11-10). Each fails at 76c9a7a + staged.

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function signedIn() {
  const page = fakePage();
  const wallet = windowWallet({ chainId: SEPOLIA, env: page.env, storage: null, extension: false });
  const accounts = wallet.request({ type: "wallet_requestAccounts" });
  const popup = page.popup();
  page.ready(popup);
  page.answer(popup, popup.requests()[0]!.id, { address: ALICE });
  return accounts.then(() => ({ page, wallet, popup }));
}

describe("F1: a window that doesn't know `deploymentData` (the one live today: it ignores a method it can't read)", () => {
  it("leaves wallet_deploymentData open for ever, and the window up", async () => {
    const { wallet, popup } = await signedIn();
    const asked = track(wallet.request({ type: "wallet_deploymentData" }));
    await settle();
    // The old window reads the request as nothing and answers nothing. An hour on:
    vi.advanceTimersByTime(3_600_000);
    await settle();
    expect(asked.settled).toBe(true);
    expect(popup.closed).toBe(true);
  });

  it("keeps the window open after the signature that follows, which it did answer", async () => {
    const { page, wallet, popup } = await signedIn();
    void wallet.request({ type: "wallet_deploymentData" }).catch(() => undefined);
    const signed = track(wallet.request({ type: "wallet_signTypedData", params: DELEGATION }));
    await settle();
    const sign = popup.requests().find((r) => r.method === "signTypedData")!;
    page.answer(popup, sign.id, { address: ALICE, signature: ["0x1"] });
    await settle();
    expect(signed.value).toEqual(["0x1"]);
    // "The window closes after" a signature (SignWindow.signTypedData).
    vi.advanceTimersByTime(3_600_000);
    expect(popup.closed).toBe(true);
  });
});

describe("F3: deployment data asked for behind a signature, in the window the sign-in left open", () => {
  it("the window closes once the signature is given, as after any signature", async () => {
    const { page, wallet, popup } = await signedIn();
    const signed = track(wallet.request({ type: "wallet_signTypedData", params: DELEGATION }));
    const data = track(wallet.request({ type: "wallet_deploymentData" }));
    await settle();
    const [sign, deployment] = popup.requests().slice(-2);
    expect([sign!.method, deployment!.method]).toEqual(["signTypedData", "deploymentData"]);
    // The window serves them in order: the approval, then the data.
    page.answer(popup, sign!.id, { address: ALICE, signature: ["0x1"] });
    page.answer(popup, deployment!.id, { address: ALICE, class_hash: "0x1234", salt: "0x0", calldata: ["0x0", "0x77", "0x1"], version: 1 });
    await settle();
    expect(signed.settled && data.settled).toBe(true);
    expect(popup.closed).toBe(true);
  });
});
