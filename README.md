# @outis/sessions

Let users sign in to your app with Outis, and sign what they do there, whether or not they have the
extension.

`outisWallet()` gives your site one standard Starknet wallet object:

- **With the Outis extension installed,** it is the extension: the full wallet, with its reviews and
  transactions.
- **Without it,** sign-ins and signatures go through a small Outis window at `sign.outis.xyz`. Users
  install nothing, and your app gets signatures from their Outis account all the same.

## What it's for

Apps where users sign actions off-chain and a contract settles them on-chain later: a game's moves,
votes, claims, or a delegation to a session key that then signs for the user. The window signs
messages, never transactions, and only the kinds of message listed for your site.

Your contract settles the actions. It checks each signature through the user's account
(`is_valid_signature`, SNIP-6), so the account must be deployed by then: your app pays that deploy,
at the user's first approval ([Deploying the user's account](#deploying-the-users-account)). Your
server usually sends the settling transaction.

[Arbiter](https://github.com/broody/arbiter) is one such setup, for turn-based games: players sign
their moves off-chain, through a session key the window delegates to once, and Arbiter settles the
game from the signed moves and every player's approval.

What a signature does is only what your contract does with it. The window refuses anything the
account would act on by itself: transactions, outside execution (SNIP-9), token permits and
approvals, orders. Anything a user must send from their own account needs the extension: moving
funds, a deposit, or with Arbiter, opening a dispute or claiming a timeout. Design your app so that
window users never need one. With Arbiter, name a referee in the game's terms, and pause play while
the referee is unavailable rather than leaving players to dispute.

## Install

```sh
npm install github:outis-wallet/sessions#v0.2.0
```

## Quick start

```ts
import { outisWallet } from "@outis/sessions";

// Once, at module level: the wallet listens for its window's messages.
const outis = outisWallet({ chainId: "0x534e5f5345504f4c4941" }); // SN_SEPOLIA

button.onclick = async () => {
  const [address] = (await outis.request({ type: "wallet_requestAccounts" })) as string[];
  const signature = (await outis.request({ type: "wallet_signTypedData", params: typedData })) as string[];
};
```

With get-starknet's wallet standard, wrap it as any injected wallet:

```ts
import { StarknetInjectedWallet } from "@starknet-io/get-starknet-wallet-standard";

const wallet = new StarknetInjectedWallet(outis as never);
```

`outis.kind` says which one answers: `"extension"` or `"window"`.

## Signing in

`wallet_requestAccounts` opens the window, and the user signs in there. Your site remembers the
account, so later visits reconnect without a window:

```ts
await outis.request({ type: "wallet_requestAccounts", params: { silent_mode: true } }); // [address] or []
```

To sign out, call `forget()`. get-starknet's `disconnect` only clears its own state, so without
`forget()` the next sign-in returns the same account.

```ts
outis.forget();
```

## Opening the window in the click

Browsers block a window opened long after the click that asked for it. A request made straight from
a click handler opens its window itself. If your handler does other work first, such as a fetch,
open the window at the start and the request goes to it:

```ts
button.onclick = async () => {
  outis.open(); // in the click, before any await
  const typedData = await fetch("/challenge").then((r) => r.json());
  const signature = await outis.request({ type: "wallet_signTypedData", params: typedData });
};
```

After a sign-in, the window stays open for 30 seconds, ready for the signature that usually follows.

## Deploying the user's account

A user who signed in through the window has an Outis account that isn't on chain yet, and the window
sends no transactions. Your app deploys it, once, from an account of its own, before the first
signature a contract has to check. `wallet_deploymentData` says how:

```ts
import { OUTIS_ACCOUNT_CLASS_HASH } from "@outis/sessions";
import { hash } from "starknet";

const [address] = (await outis.request({ type: "wallet_requestAccounts" })) as string[];
const data = (await outis.request({ type: "wallet_deploymentData" })) as {
  address: string; // the account, as wallet_requestAccounts gave it
  class_hash: string;
  salt: string;
  calldata: string[]; // the constructor's
  version: 1; // Cairo 1
};
```

Ask right after the sign-in, while its window is still open (30 seconds): it answers there, with
nothing asked of the user. Later, ask in a click, as the request opens the window for a moment. It
signs no one in: it needs the account your site already knows, and is refused (116) before a
sign-in, or where the window no longer has anyone signed in (ask for `wallet_requestAccounts`
again). A window that doesn't answer within ten seconds of its turn is a refusal too (163). Where
you also ask for signatures, ask for the data before them or after them, not between two you send
together: the window shows signatures sent together as one approval, and a request between them
makes it two.

Then, on your server or wherever your funded account is:

1. **Check that the data deploys this account, as an Outis account**, before paying for it. An
   address is a hash of its class, salt and constructor calldata, deployed from address 0, so the
   hash ties the data to the address; the class is checked apart, or you would deploy whatever
   class the data names:

   ```ts
   const lands = hash.calculateContractAddressFromHash(data.salt, data.class_hash, data.calldata, 0);
   if (BigInt(lands) !== BigInt(address)) throw new Error("Not this account's deployment data");
   if (BigInt(data.class_hash) !== BigInt(OUTIS_ACCOUNT_CLASS_HASH)) throw new Error("Not an Outis account");
   ```

   The SDK reads the data for its shape only: these two checks are yours.

2. **Skip it if the account is already deployed** (`provider.getClassHashAt(address)` answers instead
   of failing). The window reads no chain, so it answers either way, and a second deploy reverts at
   your cost. Another app, or the user's own extension, may have deployed it first.

3. **Deploy through the universal deployer, from address zero:** `unique` (`not_from_zero`) must be
   `false`, or the contract lands at another address and the account stays undeployed.

   ```ts
   await funded.deployContract({
     classHash: data.class_hash,
     salt: data.salt,
     unique: false,
     constructorCalldata: data.calldata,
   });
   // which sends: deploy_contract(class_hash, salt, not_from_zero: false, calldata) to the deployer
   ```

Your funded account pays for every account it deploys, and anyone with an email can sign in: bound
the fee, and deploy when a player first does something that needs it rather than at every sign-in.

Wait for that transaction before asking a contract to check the user's signature. With the
extension, the same request goes to the extension, which answers in the same shape for an account
that isn't deployed, and refuses (115) for one that is; an extension user can also deploy their own.

## Getting your site listed

The window answers only the sites on its list, each by its exact origin, and signs only the message
kinds reviewed for each one: their SNIP-12 domain (name, version, chain) and types. Ask the Outis team
to list your origins and your messages.

Your pages must keep their link to the window: don't send `Cross-Origin-Opener-Policy: same-origin`
(`same-origin-allow-popups` is fine).

## Reference

### `outisWallet(options)`

| Option | |
|---|---|
| `chainId` | The chain your app is on, in hex: `0x534e5f4d41494e` (mainnet) or `0x534e5f5345504f4c4941` (Sepolia). |
| `storage` | Where the account is remembered. The page's `localStorage` by default; `null` for nowhere. |
| `extension` | `false` to use the window even where the extension is installed. |
| `holdMs` | How long the window waits after a sign-in, or after `open()` (30 000 ms). |
| `signOrigin` | Another window origin, for development. |

### The wallet

| | |
|---|---|
| `request({ type, params })` | A Starknet wallet API request. |
| `on` / `off` | `accountsChanged` and `networkChanged`. |
| `kind` | `"extension"` or `"window"`. |
| `open()` | Opens the window ahead of a request (window only). |
| `forget()` | Signs out: the site forgets the account (window only). |
| `id`, `name`, `version`, `icon` | As the extension's own object has them: `"outis"`, `"Outis"`. |

### Requests through the window

| Request | Answer |
|---|---|
| `wallet_requestAccounts` | The account your site remembers, or the window signs the user in. With `silent_mode`, `[]` instead of a window. |
| `wallet_signTypedData` | The user's signature, as felts, for the remembered account. |
| `wallet_deploymentData` | How to deploy the remembered account: `{ address, class_hash, salt, calldata, version }`. Refused before a sign-in. |
| `wallet_requestChainId`, `wallet_switchStarknetChain` | The wallet's chain; another chain is refused. |
| `wallet_getPermissions`, `wallet_supportedWalletApi`, `wallet_supportedSpecs` | Answered straight away. |
| Transactions, and everything else | Refused: they need the extension. |

With the extension, every request goes to the extension.

A request waits until the user answers or closes the window: give it no timeout
(`wallet_deploymentData`, which asks the user nothing, ends by itself). If the user
changes account (in the window, or in another tab), the site gets `accountsChanged`, and a signature
from any account but the one it asked for is refused. So is another account's deployment data.

### Errors

Requests reject with a `WalletRequestError` carrying the wallet API's code:

| Code | |
|---|---|
| `113` | The user refused, or closed the window. |
| `163` | Refused, with the reason in `data`: a transaction without the extension, a blocked window, another account. |
| `162` | An `api_version` the window doesn't answer for. |
| `114` | A request that isn't valid. |
| `116` | `wallet_deploymentData` with no one signed in. |
| `112` | Another chain. |

## How it works

The window is a page on `sign.outis.xyz` that your site opens with `window.open`. The two talk by
`postMessage`, and each side trusts only what it can check:

- **Your site** posts requests only to the window's origin, and takes an answer only from the window
  it opened, at that origin, for a request it is waiting on.
- **The window** takes requests only from the page that opened it, from an origin on its list, and
  answers only that origin. It names your site by the origin the browser reports, never by what a
  message says.
- **What is signed** is parsed strictly, the same way on both sides (`src/protocol.ts`): exact keys,
  felts and addresses written one way, and typed data that is plain JSON in SNIP-12's shape (safe
  integers only, no holes, no shared or looping objects), 64 Ki characters at most. The window shows
  the user the request in words built from the parsed message, and signs that message rebuilt from
  its own list of types, so what is signed is what was shown.

The messages, for anyone checking them:

| From | Message |
|---|---|
| Window | `{ outis: "sessions", v: 1, kind: "ready" }`, once loaded, and again after a reload: the site then sends its open requests again. |
| Site | `{ outis, v, kind: "request", id, method: "connect", chainId }` |
| Site | `{ outis, v, kind: "request", id, method: "signTypedData", chainId, account, typedData }` |
| Site | `{ outis, v, kind: "request", id, method: "deploymentData", chainId }` |
| Window | `{ outis, v, kind: "response", id, result }`: `{ address }`, or `{ address, signature }` with 1 to 64 felts, or `{ address, class_hash, salt, calldata, version: 1 }` with at most 64 felts of calldata |
| Window | `{ outis, v, kind: "response", id, error: { code, message, data? } }` |

An `id` is 128 random bits (32 hex digits). The window opens at
`https://sign.outis.xyz/?v=1&site=<your origin>&chain=<chain id>`.

## Development

```sh
npm install
npm run typecheck
npm test
npm run coverage
npm run build   # into dist/, committed with each change
```

The build is committed so that installing from GitHub builds nothing; CI checks that it matches the
source.

## License

MIT
