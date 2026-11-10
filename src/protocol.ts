// The messages between a site and the sign.outis.xyz window (README.md, "How it works"). The
// site opens the window; the window announces itself (`ready`) to the page that opened it; the site
// sends requests; the window answers each once. Both sides parse with the functions below, so a
// request the SDK sends is one the window reads, and the window's answers are read here the one way.
//
// Who checks what: the window trusts nothing the site sends. It accepts a request only from its
// opener (`event.source === window.opener`), from an origin on its list (`event.origin`, set by the
// browser), answers only to that origin, and signs only the kinds of message listed for it. The SDK
// accepts an answer only from the window it opened, at the sign origin, for an id it is waiting on.

/** Where the window lives. A local page in development is named in `SessionOptions.signOrigin`. */
export const SIGN_ORIGIN = "https://sign.outis.xyz";
export const PROTOCOL_VERSION = 1;
/** The size of the window, in CSS pixels. */
export const WINDOW_SIZE = { width: 400, height: 640 };
/** The most a message to sign may take, in characters of JSON. */
export const MAX_TYPED_DATA_LENGTH = 65_536;
/** The most felts a signature may have. */
export const MAX_SIGNATURE_FELTS = 64;
/** The most felts a constructor's calldata may have, in an account's deployment data. */
export const MAX_CALLDATA_FELTS = 64;

/**
 * The class of every Outis account, as deployment data names it (`class_hash`). A site that pays for
 * a deploy checks the data against it: the address is a hash of whatever class the data names.
 */
export const OUTIS_ACCOUNT_CLASS_HASH = "0xeb49f5299d144f0b2e434e483758fb6d7d8241632534d86b098047fe4e2b42";

/** The Stark field's prime: every felt is below it. */
const FIELD_PRIME = 2n ** 251n + 17n * 2n ** 192n + 1n;
/** Starknet's addresses are below 2^251. */
const ADDRESS_BOUND = 2n ** 251n;
/** A chain id is a short string: 31 bytes at most. */
const CHAIN_BOUND = 2n ** 248n;

/** The SNIP-12 message a site asks the window to sign, as JSON: what `wallet_signTypedData` takes. */
export type TypedDataJson = {
  types: Record<string, unknown>;
  primaryType: string;
  domain: Record<string, unknown>;
  message: Record<string, unknown>;
};

type Envelope = { outis: "sessions"; v: typeof PROTOCOL_VERSION };

export type ConnectRequest = Envelope & { kind: "request"; id: string; method: "connect"; chainId: string };
export type SignRequest = Envelope & {
  kind: "request";
  id: string;
  method: "signTypedData";
  chainId: string;
  /** The account the site knows the user by, or null where it knows none: the window signs for that one only. */
  account: string | null;
  typedData: TypedDataJson;
};
/** Asks how the signed-in account is deployed. It names no account: the window answers for its own, and says which. */
export type DeploymentRequest = Envelope & { kind: "request"; id: string; method: "deploymentData"; chainId: string };
/** Site → window. */
export type SessionRequest = ConnectRequest | SignRequest | DeploymentRequest;

export type ConnectResult = { address: string };
export type SignResult = { address: string; signature: string[] };
/**
 * How to deploy the signed-in account: the wallet API's ACCOUNT_DEPLOYMENT_DATA, which
 * `wallet_deploymentData` answers with. Deployed from address 0 (a deploy of its own, or the
 * universal deployer told not to make the address its caller's) with this class, salt and
 * constructor calldata, the account lands at `address`. `version` is the class's Cairo version.
 */
export type DeploymentResult = { address: string; class_hash: string; salt: string; calldata: string[]; version: 1 };

/** As the Starknet wallet API writes its errors: `{ code: 113, message: "An error occurred (USER_REFUSED_OP)" }`. */
export type ErrorPayload = { code: number; message: string; data?: string };

/** Window → site. */
export type WindowMessage =
  | (Envelope & { kind: "ready" })
  | (Envelope & { kind: "response"; id: string; result: unknown })
  | (Envelope & { kind: "response"; id: string; error: ErrorPayload });

/** The wallet API's codes Outis answers with, as the extension does. */
export const ERRORS = {
  UNLISTED_NETWORK: 112,
  USER_REFUSED_OP: 113,
  INVALID_REQUEST_PAYLOAD: 114,
  DEPLOYMENT_DATA_NOT_AVAILABLE: 116,
  API_VERSION_NOT_SUPPORTED: 162,
  UNKNOWN_ERROR: 163,
} as const;

/** An error in the wallet API's words: `walletError("USER_REFUSED_OP", "The Outis window was closed")`. */
export function walletError(name: keyof typeof ERRORS, data?: string): ErrorPayload {
  return { code: ERRORS[name], message: `An error occurred (${name})`, ...(data === undefined ? {} : { data }) };
}

// --- Reading -------------------------------------------------------------------------------------

const isRecord = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

/** Whether `value` has exactly these keys, own and enumerable, no more and no fewer. */
const hasKeys = (value: Record<string, unknown>, keys: readonly string[]) => {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
};

const ID = /^[0-9a-f]{32}$/;
const HEX = /^0x(0|[1-9a-f][0-9a-f]{0,63})$/;
const ADDRESS = /^0x[0-9a-f]{64}$/;
const CHAIN = /^0x[1-9a-f][0-9a-f]{0,61}$/;

const isId = (value: unknown): value is string => typeof value === "string" && ID.test(value);

/** A felt as the protocol writes one: `0x`, lowercase hex with no leading zero, below the field's prime. */
export const isFelt = (value: unknown): value is string => typeof value === "string" && HEX.test(value) && BigInt(value) < FIELD_PRIME;

/** An address as the protocol writes one: `0x` and 64 lowercase hex digits, not 0, below 2^251. */
export const isAddress = (value: unknown): value is string =>
  typeof value === "string" && ADDRESS.test(value) && BigInt(value) !== 0n && BigInt(value) < ADDRESS_BOUND;

/** A chain id as the protocol writes one: `0x`, lowercase hex with no leading zero, 31 bytes at most. */
export const isChainId = (value: unknown): value is string => typeof value === "string" && CHAIN.test(value);

/**
 * A chain id written the protocol's way, from hex in any case (`0x534E5F5345504F4C4941`), or
 * undefined where it isn't one.
 */
export function chainIdOf(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{1,64}$/.test(value)) return undefined;
  const n = BigInt(value);
  if (n === 0n || n >= CHAIN_BOUND) return undefined;
  return `0x${n.toString(16)}`;
}

/**
 * Whether `value` is a plain array with every index and nothing else. A structured clone keeps holes
 * and named keys, which JSON writes as null or drops, and which `every` skips.
 */
function isDense(value: unknown): value is unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || Object.keys(value).length !== value.length) return false;
  for (let i = 0; i < value.length; i++) if (!Object.prototype.hasOwnProperty.call(value, i)) return false;
  return true;
}

/**
 * Whether `value` is plain JSON (strings, safe integers, booleans, null, dense arrays, plain
 * objects), at most 32 deep, each object or array met once, and within the size limit as it is
 * walked. A structured clone can share an object between places, or loop, which JSON can't; a few
 * shared objects would otherwise be walked as billions.
 */
function isJson(root: unknown): boolean {
  const seen = new Set<object>();
  // At least what JSON writes: a character a value, a string's and a key's own length.
  let budget = MAX_TYPED_DATA_LENGTH;
  const walk = (value: unknown, depth: number): boolean => {
    if (--budget < 0) return false;
    if (value === null || typeof value === "boolean") return true;
    if (typeof value === "string") return (budget -= value.length) >= 0;
    // A number reads one way only as a safe integer: 1000000000000000100 is the double ...128, which
    // is what a hash takes and not what a page shows; -0 is written 0. SNIP-12 holds no fraction.
    if (typeof value === "number") return Number.isSafeInteger(value) && !Object.is(value, -0);
    if (depth === 0 || typeof value !== "object" || seen.has(value)) return false;
    seen.add(value);
    if (Array.isArray(value)) return isDense(value) && value.every((item) => walk(item, depth - 1));
    if (!isRecord(value)) return false;
    for (const [key, item] of Object.entries(value)) {
      // An own `__proto__` key reads as a key to JSON and a spread, and as the prototype to an
      // assignment or `Object.assign`: two readings. No SNIP-12 type or field is named so.
      if (key === "__proto__") return false;
      budget -= key.length;
      if (!walk(item, depth - 1)) return false;
    }
    return true;
  };
  return walk(root, 32);
}

/** A message to sign, if `value` is one: the four parts SNIP-12 has, nothing else, plain JSON, not too large. */
export function typedDataOf(value: unknown): TypedDataJson | undefined {
  if (!isRecord(value) || !hasKeys(value, ["types", "primaryType", "domain", "message"])) return undefined;
  const { types, primaryType, domain, message } = value;
  if (!isRecord(types) || typeof primaryType !== "string" || !isRecord(domain) || !isRecord(message)) return undefined;
  if (!isJson(value) || JSON.stringify(value).length > MAX_TYPED_DATA_LENGTH) return undefined;
  // SNIP-12's shape, so that what passes here is something a hash can be taken of: a domain type,
  // the message's own type, and every type a list of fields, each a name and a type (and what an
  // enum or a merkle tree contains).
  if (!Object.hasOwn(types, primaryType) || !(Object.hasOwn(types, "StarknetDomain") || Object.hasOwn(types, "StarkNetDomain"))) return undefined;
  const isField = (field: unknown) =>
    isRecord(field) &&
    typeof field.name === "string" &&
    typeof field.type === "string" &&
    (hasKeys(field, ["name", "type"]) || (hasKeys(field, ["name", "type", "contains"]) && typeof field.contains === "string"));
  if (!Object.values(types).every((fields) => Array.isArray(fields) && fields.every(isField))) return undefined;
  return value as TypedDataJson;
}

const isEnvelope = (value: unknown): value is Record<string, unknown> =>
  isRecord(value) && value.outis === "sessions" && value.v === PROTOCOL_VERSION;

/** A request, as the window reads one from the site (and the SDK checks one before sending), or null. */
export function parseRequest(value: unknown): SessionRequest | null {
  if (!isEnvelope(value) || value.kind !== "request" || !isId(value.id)) return null;
  if (!isChainId(value.chainId)) return null;
  if (value.method === "connect") {
    return hasKeys(value, ["outis", "v", "kind", "id", "method", "chainId"]) ? (value as ConnectRequest) : null;
  }
  if (value.method === "deploymentData") {
    return hasKeys(value, ["outis", "v", "kind", "id", "method", "chainId"]) ? (value as DeploymentRequest) : null;
  }
  if (value.method === "signTypedData") {
    if (!hasKeys(value, ["outis", "v", "kind", "id", "method", "chainId", "account", "typedData"])) return null;
    if (value.account !== null && !isAddress(value.account)) return null;
    return typedDataOf(value.typedData) ? (value as SignRequest) : null;
  }
  return null;
}

function errorOf(value: unknown): ErrorPayload | undefined {
  if (!isRecord(value)) return undefined;
  const { code, message, data } = value;
  if (!Number.isInteger(code) || Object.is(code, -0) || (code as number) < 0 || (code as number) > 65_535) return undefined;
  if (typeof message !== "string" || message.length > 300) return undefined;
  // `data` absent, or there as undefined (as `{ code, message, data }` writes no data in TypeScript).
  if (data === undefined) return hasKeys(value, ["code", "message"]) || hasKeys(value, ["code", "message", "data"]) ? { code: code as number, message } : undefined;
  if (typeof data !== "string" || data.length > 2_000 || !hasKeys(value, ["code", "message", "data"])) return undefined;
  return { code: code as number, message, data };
}

/** A message from the window, as the SDK reads one, or null. What a result holds is read by `connectResultOf`, `signResultOf` and `deploymentResultOf`. */
export function parseWindowMessage(value: unknown): WindowMessage | null {
  if (!isEnvelope(value)) return null;
  if (value.kind === "ready") return hasKeys(value, ["outis", "v", "kind"]) ? (value as WindowMessage) : null;
  if (value.kind !== "response" || !isId(value.id)) return null;
  if (hasKeys(value, ["outis", "v", "kind", "id", "result"])) return value as WindowMessage;
  if (!hasKeys(value, ["outis", "v", "kind", "id", "error"])) return null;
  const error = errorOf(value.error);
  return error ? { outis: "sessions", v: PROTOCOL_VERSION, kind: "response", id: value.id, error } : null;
}

/** The id a message names as an answer, where it reads as one (envelope, kind, id) whatever else it holds. */
export function responseIdOf(value: unknown): string | undefined {
  return isEnvelope(value) && value.kind === "response" && isId(value.id) ? value.id : undefined;
}

/** A connect answer's result, if it is one: the account's address. */
export function connectResultOf(value: unknown): ConnectResult | undefined {
  return isRecord(value) && hasKeys(value, ["address"]) && isAddress(value.address) ? { address: value.address } : undefined;
}

/** A signature answer's result, if it is one: the account that signed and its signature, felts. */
export function signResultOf(value: unknown): SignResult | undefined {
  if (!isRecord(value) || !hasKeys(value, ["address", "signature"]) || !isAddress(value.address)) return undefined;
  const { signature } = value;
  if (!isDense(signature) || signature.length === 0 || signature.length > MAX_SIGNATURE_FELTS || !signature.every(isFelt)) return undefined;
  return { address: value.address, signature: [...signature] };
}

/**
 * A deployment data answer's result, if it is one: the account, its class, the salt and the
 * constructor's calldata, felts, and Cairo version 1. Read here for its shape only: that these
 * deploy to `address` is a hash the site takes before it pays for the deploy (README, "Deploying
 * the user's account").
 */
export function deploymentResultOf(value: unknown): DeploymentResult | undefined {
  if (!isRecord(value) || !hasKeys(value, ["address", "class_hash", "salt", "calldata", "version"])) return undefined;
  const { address, class_hash, salt, calldata, version } = value;
  if (!isAddress(address) || !isFelt(class_hash) || class_hash === "0x0" || !isFelt(salt) || version !== 1) return undefined;
  if (!isDense(calldata) || calldata.length > MAX_CALLDATA_FELTS || !calldata.every(isFelt)) return undefined;
  return { address, class_hash, salt, calldata: [...calldata], version: 1 };
}

/** The window's address for a site: the site's origin, where the window posts `ready`, and the chain it plays on. */
export function windowUrl(signOrigin: string, site: string, chainId: string): string {
  const query = new URLSearchParams({ v: String(PROTOCOL_VERSION), site, chain: chainId });
  return `${signOrigin}/?${query}`;
}
