import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signResultOf } from "../src/protocol";
import { windowWallet, type StorageLike } from "../src/wallet";
import { ALICE, BOB, DELEGATION, SEPOLIA, fakePage, settle, track } from "./fakes";

class MemoryStorage implements StorageLike {
  readonly items = new Map<string, string>();
  getItem(key: string) { return this.items.get(key) ?? null; }
  setItem(key: string, value: string) { this.items.set(key, value); }
  removeItem(key: string) { this.items.delete(key); }
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function setup(storage: StorageLike | null = new MemoryStorage()) {
  const page = fakePage();
  const wallet = windowWallet({ chainId: SEPOLIA, env: page.env, storage });
  const changes: unknown[] = [];
  wallet.on("accountsChanged", (accounts) => changes.push(accounts));
  return { page, wallet, changes };
}

const accounts = { type: "wallet_requestAccounts" };
const sign = { type: "wallet_signTypedData", params: DELEGATION };
const silent = { type: "wallet_requestAccounts", params: { silent_mode: true } };

describe("a signature result must contain actual felts", () => {
  it("rejects every sparse signature, after structured clone (property)", () => {
    fc.assert(fc.property(
      fc.integer({ min: 1, max: 64 }), fc.nat(),
      (length, seed) => {
        const signature = Array<string>(length).fill("0x1");
        delete signature[seed % length];
        const wire = structuredClone({ address: ALICE, signature });
        expect(signResultOf(wire)).toBeUndefined();
      },
    ));
  });

  it("rejects an all-hole signature instead of resolving and remembering the account", async () => {
    const { page, wallet } = setup();
    const result = track(wallet.request(sign));
    page.ready(page.popup());
    page.answer(page.popup(), page.popup().requests()[0]!.id, { address: ALICE, signature: Array(2) });
    await settle();
    expect(result.error).toMatchObject({ code: 163 });
    expect(result.value).toBeUndefined();
    await expect(wallet.request(silent)).resolves.toEqual([]);
  });
});

describe("concurrent account operations", () => {
  it("does not return Bob's signature together with a later Alice connection", async () => {
    const { page, wallet } = setup();
    const connected = track(wallet.request(accounts));
    const signed = track(wallet.request(sign));
    const popup = page.popup();
    page.ready(popup);
    const [connectRequest, signRequest] = popup.requests();
    expect(signRequest!.account).toBeNull();
    // These are two independently valid answers: the sign request names no account.
    page.answer(popup, signRequest!.id, { address: BOB, signature: ["0x5"] });
    await settle();
    page.answer(popup, connectRequest!.id, { address: ALICE });
    await settle();
    expect(signed.value).toEqual(["0x5"]);
    // If the sign result was accepted for Bob, a pending connect must not subsequently
    // resolve Alice and silently move the account underneath that successful signature.
    expect(connected.value).not.toEqual([ALICE]);
    await expect(wallet.request(silent)).resolves.toEqual([BOB]);
  });

  it("detects a legitimate account change in another tab while a signature is pending", async () => {
    const shared = new MemoryStorage();
    const first = setup(shared);
    const firstConnect = track(first.wallet.request(accounts));
    first.page.ready(first.page.popup());
    first.page.answer(first.page.popup(), first.page.popup().requests()[0]!.id, { address: ALICE });
    await settle();
    expect(firstConnect.value).toEqual([ALICE]);
    const signed = track(first.wallet.request(sign));
    const request = first.page.popup().requests().at(-1)!;
    expect(request.account).toBe(ALICE);

    const second = setup(shared);
    second.wallet.forget();
    const secondConnect = track(second.wallet.request(accounts));
    second.page.ready(second.page.popup());
    second.page.answer(second.page.popup(), second.page.popup().requests()[0]!.id, { address: BOB });
    await settle();
    expect(secondConnect.value).toEqual([BOB]);

    first.page.answer(first.page.popup(), request.id, { address: ALICE, signature: ["0x7"] });
    await settle();
    await expect(first.wallet.request(silent)).resolves.toEqual([BOB]);
    expect(signed.error).toMatchObject({ code: 163 });
    expect(signed.value).toBeUndefined();
  });
});

describe("loss of persistent storage must not lose the connected identity", () => {
  it.each(["absent", "denied"] as const)("binds signing to the account it just returned when storage is %s", async (mode) => {
    const denied: StorageLike = {
      getItem() { throw new Error("denied"); },
      setItem() { throw new Error("denied"); },
      removeItem() { throw new Error("denied"); },
    };
    const { page, wallet } = setup(mode === "absent" ? null : denied);
    const connected = track(wallet.request(accounts));
    page.ready(page.popup());
    page.answer(page.popup(), page.popup().requests()[0]!.id, { address: ALICE });
    await settle();
    expect(connected.value).toEqual([ALICE]);
    const signed = track(wallet.request(sign));
    const request = page.popup().requests().at(-1)!;
    page.answer(page.popup(), request.id, { address: BOB, signature: ["0x8"] });
    await settle();
    expect(request.account).toBe(ALICE);
    expect(signed.error).toMatchObject({ code: 163 });
  });
});

describe("wallet API version metadata", () => {
  it("accepts signing with an explicitly selected advertised API version", async () => {
    const { page, wallet } = setup();
    const versions = await wallet.request({ type: "wallet_supportedWalletApi" });
    expect(versions).toContain("0.10");
    const signed = track(wallet.request({ type: "wallet_signTypedData", params: { ...DELEGATION, api_version: "0.10" } }));
    await settle();
    expect(signed.error).toBeUndefined();
    expect(page.popups).toHaveLength(1);
    page.ready(page.popup());
    const request = page.popup().requests()[0]!;
    expect(request.typedData).toEqual(DELEGATION);
    page.answer(page.popup(), request.id, { address: ALICE, signature: ["0x1"] });
    await settle();
    expect(signed.value).toEqual(["0x1"]);
  });
});
