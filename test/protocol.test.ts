import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  MAX_SIGNATURE_FELTS,
  MAX_TYPED_DATA_LENGTH,
  chainIdOf,
  connectResultOf,
  isAddress,
  isFelt,
  parseRequest,
  parseWindowMessage,
  signResultOf,
  typedDataOf,
  walletError,
  windowUrl,
} from "../src/protocol";
import { ALICE, DELEGATION, SEPOLIA, SITE } from "./fakes";

const PRIME = 2n ** 251n + 17n * 2n ** 192n + 1n;
const hex = (n: bigint) => `0x${n.toString(16)}`;
const address = (n: bigint) => `0x${n.toString(16).padStart(64, "0")}`;
const ID = "ab".repeat(16);

const connect = { outis: "sessions", v: 1, kind: "request", id: ID, method: "connect", chainId: SEPOLIA };
const sign = { ...connect, method: "signTypedData", account: ALICE, typedData: DELEGATION };

describe("parseRequest", () => {
  it("reads the two requests, through a structured clone", () => {
    expect(parseRequest(structuredClone(connect))).toEqual(connect);
    expect(parseRequest(structuredClone(sign))).toEqual(sign);
    expect(parseRequest(structuredClone({ ...sign, account: null }))).toEqual({ ...sign, account: null });
  });

  it("refuses anything with a key more or less", () => {
    for (const request of [connect, sign, { ...connect, method: "deploymentData" }]) {
      for (const key of Object.keys(request)) {
        const { [key]: _, ...fewer } = request as Record<string, unknown>;
        expect(parseRequest(fewer), `without ${key}`).toBeNull();
      }
      expect(parseRequest({ ...request, extra: 1 })).toBeNull();
    }
    expect(parseRequest({ ...connect, account: ALICE })).toBeNull();
  });

  it("refuses another protocol, version, kind, method or id", () => {
    for (const change of [
      { outis: "extension-request" },
      { v: 2 },
      { v: "1" },
      { kind: "response" },
      { method: "signTransaction" },
      { method: "execute" },
      { id: "AB".repeat(16) },
      { id: "ab".repeat(15) },
      { id: 7 },
    ]) {
      expect(parseRequest({ ...connect, ...change }), JSON.stringify(change)).toBeNull();
    }
  });

  it("refuses a chain id or an account written another way", () => {
    for (const chainId of ["0x534E5F5345504F4C4941", "0x0534e5f5345504f4c4941", "SN_SEPOLIA", "0x", "0x0", 1, `0x${"1".repeat(63)}`]) {
      expect(parseRequest({ ...connect, chainId }), String(chainId)).toBeNull();
    }
    for (const account of [ALICE.toUpperCase().replace("0X", "0x"), "0xa11ce", address(0n), address(2n ** 251n), ALICE.slice(2), undefined]) {
      expect(parseRequest({ ...sign, account }), String(account)).toBeNull();
    }
  });

  it("refuses a message to sign that isn't plain JSON with SNIP-12's four parts", () => {
    const deep = (n: number): unknown => (n === 0 ? 1 : { a: deep(n - 1) });
    for (const typedData of [
      null,
      [],
      "message",
      { ...DELEGATION, extra: 1 },
      { types: DELEGATION.types, primaryType: "Delegation", domain: DELEGATION.domain },
      { ...DELEGATION, primaryType: 1 },
      { ...DELEGATION, types: [] },
      { ...DELEGATION, domain: null },
      { ...DELEGATION, message: { expires_at: 10n } },
      { ...DELEGATION, message: { at: new Date(0) } },
      { ...DELEGATION, message: { keys: new Map() } },
      { ...DELEGATION, message: { gone: undefined } },
      { ...DELEGATION, message: { n: Number.NaN } },
      { ...DELEGATION, message: { n: Infinity } },
      // Numbers that read two ways: past 2^53 (the double a hash takes isn't the decimal shown), -0
      // (JSON writes 0), and fractions (no SNIP-12 type holds one).
      { ...DELEGATION, message: { key: 1000000000000000100 } },
      { ...DELEGATION, message: { key: 2 ** 53 } },
      { ...DELEGATION, message: { key: -0 } },
      { ...DELEGATION, message: { key: 1.5 } },
      { ...DELEGATION, message: { bytes: new Uint8Array(2) } },
      { ...DELEGATION, message: deep(40) },
      { ...DELEGATION, message: { big: "x".repeat(MAX_TYPED_DATA_LENGTH) } },
      { ...DELEGATION, message: { many: Array(MAX_TYPED_DATA_LENGTH).fill(0) } },
      { ...DELEGATION, message: { ["k".repeat(MAX_TYPED_DATA_LENGTH)]: 1 } },
    ]) {
      expect(parseRequest({ ...sign, typedData }), JSON.stringify(typedData, (_, v) => (typeof v === "bigint" ? `${v}n` : v))?.slice(0, 80)).toBeNull();
    }
    expect(typedDataOf({ ...DELEGATION, message: deep(25) })).toBeDefined();
    expect(typedDataOf({ ...DELEGATION, message: { key: 2 ** 53 - 1, low: -(2 ** 53 - 1) } })).toBeDefined();
  });

  it("refuses a message without SNIP-12's shape: its type, a domain type, fields of a name and a type", () => {
    const { Delegation, StarknetDomain } = DELEGATION.types;
    for (const types of [
      { StarknetDomain },
      { Delegation },
      { StarknetDomain, Delegation: "game:shortstring" },
      { StarknetDomain, Delegation: [{ name: "game" }] },
      { StarknetDomain, Delegation: [{ name: "game", type: 7 }] },
      { StarknetDomain, Delegation: [{ name: "game", type: "shortstring", extra: "x" }] },
      { StarknetDomain, Delegation: [{ name: "game", type: "enum", contains: 7 }] },
      { StarknetDomain, Delegation: ["game"] },
    ]) {
      expect(typedDataOf({ ...DELEGATION, types }), JSON.stringify(types)).toBeUndefined();
    }
    const enumField = { name: "side", type: "enum", contains: "Side" };
    expect(typedDataOf({ ...DELEGATION, types: { StarknetDomain, Delegation: [...(Delegation as unknown[]), enumField], Side: [] } })).toBeDefined();
    expect(typedDataOf({ ...DELEGATION, types: { StarkNetDomain: StarknetDomain, Delegation } })).toBeDefined();
  });

  it("refuses a key named __proto__, which an assignment reads as the prototype and JSON as a key", () => {
    const message = JSON.parse('{"game":"go","channel":"0x123","key":"0x456","expires_at":"1762900000","__proto__":{"key":"0x999"}}');
    const types = JSON.parse(`{"__proto__":[],"StarknetDomain":${JSON.stringify(DELEGATION.types.StarknetDomain)},"Delegation":${JSON.stringify(DELEGATION.types.Delegation)}}`);
    for (const typedData of [{ ...DELEGATION, message }, { ...DELEGATION, types }]) {
      expect(parseRequest(structuredClone({ ...sign, typedData }))).toBeNull();
    }
  });

  it("refuses an object met twice or looping, as a structured clone can carry and JSON can't", () => {
    const shared = { name: "game", type: "shortstring" };
    const looped: Record<string, unknown> = { a: 1 };
    looped.self = looped;
    for (const message of [{ a: shared, b: shared }, looped]) {
      expect(parseRequest(structuredClone({ ...sign, typedData: { ...DELEGATION, message } }))).toBeNull();
    }
  });

  it("refuses arrays JSON would write otherwise: holes, and named keys beside the items", () => {
    const fields = DELEGATION.types.Delegation as unknown[];
    const holed = [...fields];
    delete holed[1];
    const named = Object.assign([...fields], { extra: { name: "x", type: "felt" } });
    const holedAndNamed = Object.assign([...holed], { extra: 1 });
    for (const array of [holed, named, holedAndNamed, Array(2)]) {
      // As postMessage delivers them: a structured clone keeps holes and named keys; JSON doesn't.
      const typedData = structuredClone({ ...DELEGATION, types: { ...DELEGATION.types, Delegation: array } });
      expect(typedDataOf(typedData)).toBeUndefined();
      expect(parseRequest(structuredClone({ ...sign, typedData }))).toBeNull();
    }
  });

  it("reads back every request written the protocol's way, and nothing with a key added (property)", () => {
    // JSON whose numbers are safe integers and with no key named __proto__: the protocol takes no other.
    const key = fc.string().filter((k) => k !== "__proto__");
    const { json } = fc.letrec<{ json: unknown }>((tie) => ({
      json: fc.oneof(
        { depthSize: "small", maxDepth: 4 },
        fc.constant(null),
        fc.boolean(),
        fc.string(),
        fc.maxSafeInteger(),
        fc.array(tie("json"), { maxLength: 4 }),
        fc.dictionary(key, tie("json"), { maxKeys: 4 }),
      ),
    }));
    const record = fc.dictionary(key, json, { maxKeys: 4 });
    const request = fc.record({
      outis: fc.constant("sessions"),
      v: fc.constant(1),
      kind: fc.constant("request"),
      id: fc.stringMatching(/^[0-9a-f]{32}$/),
      method: fc.constant("signTypedData"),
      chainId: fc.bigInt({ min: 1n, max: 2n ** 248n - 1n }).map(hex),
      account: fc.option(fc.bigInt({ min: 1n, max: 2n ** 251n - 1n }).map(address), { nil: null }),
      typedData: fc
        .record({
          primaryType: key,
          fields: fc.array(fc.record({ name: fc.string(), type: fc.string() }), { maxLength: 4 }),
          others: fc.dictionary(key, fc.array(fc.record({ name: fc.string(), type: fc.string(), contains: fc.string() }), { maxLength: 2 }), { maxKeys: 2 }),
          domain: record,
          message: record,
        })
        .map(({ primaryType, fields, others, domain, message }) => ({
          types: { ...others, StarknetDomain: [{ name: "name", type: "shortstring" }], [primaryType]: fields },
          primaryType,
          domain,
          message,
        })),
    });
    fc.assert(
      fc.property(request, fc.string(), (r, key) => {
        // A message JSON makes `-0` of reads as 0: the window reads what was sent.
        const sent = JSON.parse(JSON.stringify(r));
        expect(parseRequest(structuredClone(sent))).toEqual(sent);
        if (!(key in sent)) expect(parseRequest({ ...sent, [key]: 1 })).toBeNull();
      }),
    );
  });
});

describe("parseWindowMessage", () => {
  const response = { outis: "sessions", v: 1, kind: "response", id: ID };

  it("reads ready, an answer and a refusal", () => {
    expect(parseWindowMessage({ outis: "sessions", v: 1, kind: "ready" })).toEqual({ outis: "sessions", v: 1, kind: "ready" });
    expect(parseWindowMessage({ ...response, result: { anything: 1 } })).toEqual({ ...response, result: { anything: 1 } });
    expect(parseWindowMessage({ ...response, error: walletError("USER_REFUSED_OP") })).toEqual({ ...response, error: { code: 113, message: "An error occurred (USER_REFUSED_OP)" } });
    expect(parseWindowMessage({ ...response, error: walletError("UNKNOWN_ERROR", "why") })).toEqual({ ...response, error: { code: 163, message: "An error occurred (UNKNOWN_ERROR)", data: "why" } });
  });

  it("refuses anything else", () => {
    for (const message of [
      null,
      "ready",
      { outis: "sessions", v: 1, kind: "ready", id: ID },
      { outis: "sessions", v: 2, kind: "ready" },
      { outis: "extension-response", v: 1, kind: "ready" },
      { ...response },
      { ...response, result: 1, error: walletError("USER_REFUSED_OP") },
      { ...response, result: 1, extra: 1 },
      { ...response, id: "AB".repeat(16), result: 1 },
      { ...response, kind: "request", result: 1 },
      { ...response, error: { code: 113 } },
      { ...response, error: { code: 1.5, message: "x" } },
      { ...response, error: { code: -1, message: "x" } },
      { ...response, error: { code: -0, message: "x" } },
      { ...response, error: { code: 113, message: "x", data: 5 } },
      { ...response, error: { code: 113, message: "x".repeat(301) } },
      { ...response, error: { code: 113, message: "x", data: "x".repeat(2001) } },
      { ...response, error: { code: 113, message: "x", stack: "" } },
    ]) {
      expect(parseWindowMessage(message), JSON.stringify(message)?.slice(0, 80)).toBeNull();
    }
  });
});

describe("results", () => {
  it("reads a connect's address, written the protocol's way", () => {
    expect(connectResultOf({ address: ALICE })).toEqual({ address: ALICE });
    for (const result of [{ address: "0xa11ce" }, { address: ALICE, extra: 1 }, { address: address(0n) }, {}, null, [ALICE]]) {
      expect(connectResultOf(result), JSON.stringify(result)).toBeUndefined();
    }
  });

  it("reads a signature: its account and one to 64 felts", () => {
    expect(signResultOf({ address: ALICE, signature: ["0x0", hex(PRIME - 1n)] })).toEqual({ address: ALICE, signature: ["0x0", hex(PRIME - 1n)] });
    for (const result of [
      { address: ALICE, signature: [] },
      { address: ALICE, signature: Array(MAX_SIGNATURE_FELTS + 1).fill("0x1") },
      { address: ALICE, signature: [hex(PRIME)] },
      { address: ALICE, signature: ["0xA"] },
      { address: ALICE, signature: ["10"] },
      { address: ALICE, signature: [1] },
      { address: ALICE, signature: "0x1" },
      { address: ALICE },
      { signature: ["0x1"] },
      { address: ALICE, signature: ["0x1"], extra: 1 },
    ]) {
      expect(signResultOf(result), JSON.stringify(result)).toBeUndefined();
    }
    expect(signResultOf({ address: ALICE, signature: Array(MAX_SIGNATURE_FELTS).fill("0x1") })).toBeDefined();
  });

  it("writes a felt one way: no leading zero", () => {
    expect(isFelt("0x1")).toBe(true);
    expect(isFelt("0x0")).toBe(true);
    for (const felt of ["0x01", "0x00", "0x0a"]) expect(isFelt(felt), felt).toBe(false);
    expect(signResultOf({ address: ALICE, signature: ["0x01"] })).toBeUndefined();
  });

  it("bounds felts and addresses where Starknet does", () => {
    expect(isFelt(hex(PRIME - 1n))).toBe(true);
    expect(isFelt(hex(PRIME))).toBe(false);
    expect(isAddress(address(2n ** 251n - 1n))).toBe(true);
    expect(isAddress(address(2n ** 251n))).toBe(false);
    expect(isAddress(address(1n))).toBe(true);
  });
});

describe("chainIdOf", () => {
  it("writes a chain id one way, from hex in any case", () => {
    expect(chainIdOf("0x534E5F5345504F4C4941")).toBe(SEPOLIA);
    expect(chainIdOf("0x00534e5f5345504f4c4941")).toBe(SEPOLIA);
    expect(chainIdOf("0x534e5f4d41494e")).toBe("0x534e5f4d41494e");
    for (const value of ["SN_SEPOLIA", "0x", "0x0", "534e", `0x1${"0".repeat(62)}`, 5, null]) {
      expect(chainIdOf(value), String(value)).toBeUndefined();
    }
  });
});

describe("windowUrl", () => {
  it("names the site and the chain in the query", () => {
    const url = new URL(windowUrl("https://account.outis.xyz", `${SITE}/?&x=1#y`, SEPOLIA));
    expect(url.origin).toBe("https://account.outis.xyz");
    expect(url.searchParams.get("site")).toBe(`${SITE}/?&x=1#y`);
    expect(url.searchParams.get("chain")).toBe(SEPOLIA);
    expect(url.hash).toBe("");
  });
});
