import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SIGN_ORIGIN, deploymentResultOf, type DeploymentResult } from "../src/protocol";
import { SignWindow } from "../src/signWindow";
import { windowWallet } from "../src/wallet";
import { parseRequest as oldParseRequest } from "./auditFixtures/protocolV010";
import { ALICE, BOB, DELEGATION, SEPOLIA, fakePage, settle, track } from "./fakes";

// Valid Outis account vectors for private keys 1 and 2, independently calculated with
// starknet.js 10.8.0 and checked in the window audit test with SignKey/defaultDeployer.
const PLAYER = "0x038aed79616d5ccb509469793945b37d3ebc972426bd8124306a5331d0f00dee";
const OTHER: DeploymentResult = {
  address: "0x04e2dc2ff4de4f8c38b246266c81ef9b08da50955bbe003a2df68f7109b21552",
  class_hash: "0xeb49f5299d144f0b2e434e483758fb6d7d8241632534d86b098047fe4e2b42",
  salt: "0x0",
  calldata: ["0x0", "0x759ca09377679ecd535a81e83039658bf40959283187c654c5416f439403cf5", "0x1"],
  version: 1,
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
const client = (page: ReturnType<typeof fakePage>) => new SignWindow({ signOrigin: SIGN_ORIGIN, chainId: SEPOLIA, holdMs: 30_000 }, page.env);

describe("deployment data audit regressions", () => {
  // By design (decided 2026-11-10, "keep it dependency-free"): the SDK has no dependency and so no pedersen, and reads the data for
  // its shape only; that it hashes to the address, and names the Outis class, is the paying site's
  // check (README, "Deploying the user's account", step 1). `fails` records that the SDK alone
  // doesn't refuse this: it turns red the day the SDK checks the hash itself.
  it.fails("F1: refuses another account's constructor relabelled with the remembered address", async () => {
    const page = fakePage();
    const wallet = windowWallet({ chainId: SEPOLIA, env: page.env, storage: null });
    const connected = wallet.request({ type: "wallet_requestAccounts" });
    const popup = page.popup();
    page.ready(popup);
    page.answer(popup, popup.requests()[0]!.id, { address: PLAYER });
    await connected;
    const asked = track(wallet.request({ type: "wallet_deploymentData" }));
    const forged = { ...OTHER, address: PLAYER };
    // The malformed semantic binding preserves every parser premise.
    expect(deploymentResultOf(structuredClone(forged))).toEqual(forged);
    page.answer(popup, popup.requests().at(-1)!.id, forged);
    await settle();
    expect(asked.settled).toBe(true);
    expect(asked.error).toBeDefined();
    expect(asked.value).toBeUndefined();
    wallet.forget();
  });

  it("F2: refuses deploymentData against the v0.1.0 window instead of waiting forever", async () => {
    const page = fakePage();
    const wallet = windowWallet({ chainId: SEPOLIA, env: page.env, storage: null });
    const connected = wallet.request({ type: "wallet_requestAccounts" });
    const popup = page.popup();
    page.ready(popup); // the exact ready envelope the old window sends
    const connect = oldParseRequest(popup.requests()[0]);
    expect(connect?.method).toBe("connect");
    page.answer(popup, connect!.id, { address: ALICE });
    await connected;
    const asked = track(wallet.request({ type: "wallet_deploymentData" }));
    expect(oldParseRequest(popup.requests().at(-1))).toBeNull(); // old window ignores it
    page.ready(popup); // a reload just resends the same unsupported request
    expect(oldParseRequest(popup.requests().at(-1))).toBeNull();
    vi.advanceTimersByTime(3_600_000);
    await settle();
    const observed = { settled: asked.settled, error: asked.error, closed: popup.closed };
    wallet.forget();
    // No user interaction is outstanding: support must be negotiated or bounded.
    expect(observed.settled).toBe(true);
    expect(observed.error).toBeDefined();
    expect(observed.closed).toBe(true);
  });

  it.each([false, true])("F4: deploymentData must preserve signature-close intent (refused=%s)", async (refused) => {
    const page = fakePage();
    const window = client(page);
    const signed = track(window.signTypedData(DELEGATION, ALICE));
    const deployment = track(window.deploymentData());
    const popup = page.popup();
    page.ready(popup);
    const [sign, deploy] = popup.requests();
    if (refused) page.fail(popup, sign!.id, { code: 113, message: "The user refused" });
    else page.answer(popup, sign!.id, { address: ALICE, signature: ["0x1"] });
    await settle();
    expect(signed.settled).toBe(true);
    expect(popup.closed).toBe(false); // correct while another request is pending
    page.answer(popup, deploy!.id, OTHER);
    await settle();
    expect(deployment.settled).toBe(true);
    const closed = popup.closed;
    window.close();
    expect(closed).toBe(true); // currently held another 30 seconds
  });

  it("F4: two concurrent deployment requests close the popup that they opened", async () => {
    const page = fakePage();
    const window = client(page);
    const first = track(window.deploymentData());
    const second = track(window.deploymentData());
    const popup = page.popup();
    page.ready(popup);
    for (const request of popup.requests()) page.answer(popup, request.id, OTHER);
    await settle();
    expect(first.settled && second.settled).toBe(true);
    const closed = popup.closed;
    window.close();
    expect(closed).toBe(true);
  });

  it("holds: another site tab changing the remembered account invalidates a pending answer", async () => {
    let stored: string | null = ALICE;
    const page = fakePage();
    const wallet = windowWallet({ chainId: SEPOLIA, env: page.env, storage: {
      getItem: () => stored, setItem: (_key, value) => { stored = value; }, removeItem: () => { stored = null; },
    } });
    const changes: unknown[] = [];
    wallet.on("accountsChanged", (accounts) => changes.push(accounts));
    const asked = track(wallet.request({ type: "wallet_deploymentData" }));
    const popup = page.popup();
    page.ready(popup);
    stored = BOB;
    page.answer(popup, popup.requests()[0]!.id, { ...OTHER, address: ALICE });
    await settle();
    expect(asked.error).toMatchObject({ code: 163 });
    expect(asked.value).toBeUndefined();
    expect(changes).toEqual([[BOB]]);
    wallet.forget();
  });

  it("holds: a deployment reply cannot close an outstanding signature approval", async () => {
    const page = fakePage();
    const window = client(page);
    track(window.deploymentData());
    const signed = track(window.signTypedData(DELEGATION, ALICE));
    const popup = page.popup();
    page.ready(popup);
    page.answer(popup, popup.requests()[0]!.id, OTHER);
    await settle();
    vi.advanceTimersByTime(60_000);
    expect(popup.closed).toBe(false);
    expect(signed.settled).toBe(false);
    window.close();
  });
});
