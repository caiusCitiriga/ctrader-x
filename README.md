# ctrader-x

A TypeScript SDK for cTrader's Open API — connect, authenticate, stream prices, and trade, with automatic reconnection built in.

## Why

There is no official Spotware SDK for Node.js/TypeScript; official support covers mainly C# and Python. The main community alternative, Mida, went closed-source. Developers integrating the Open API directly hit real, documented friction: a raw TCP/Protobuf protocol with manual message framing, a delegated OAuth2 handshake, and enough moving parts that getting from zero to a connected, authenticated, streaming client takes real effort.

ctrader-x exists to remove that friction: a clean, typed, batteries-included client, with resilience (reconnection, backoff, outage detection) handled for you instead of left as an exercise.

This is a connectivity/SDK library, not a dashboard or a UI. It gives you the building blocks to talk to cTrader's Open API from your own Node.js backend.

## Features

- Fully typed, generated directly from Spotware's official `.proto` definitions — no hand-maintained protocol types to drift out of date.
- A TCP/TLS transport that survives real network outages: automatic reconnection with exponential backoff and jitter, a liveness watchdog that notices a silently dead connection before the OS would, and Spotware's documented rate limits enforced automatically.
- OAuth2 authorization flow plus the socket-level authentication handshake, re-run automatically after every reconnect.
- Request/response correlation, so `client.send(...)` resolves or rejects with the matching response instead of requiring you to track `clientMsgId`s yourself.
- Market data subscriptions with automatic resubscription after a reconnect, and a symbol catalog you can use standalone.
- Order placement, amendment, cancellation, position closing, and querying open positions/pending orders.

## Installation

```bash
npm install ctrader-x
```

Requires Node.js 18 or later.

## Prerequisites

Before writing any code, register an application in the [cTrader Open API portal](https://help.ctrader.com/open-api/) to obtain a `clientId` and `clientSecret`, and register a redirect URI for the OAuth2 flow (e.g. `http://localhost:3939/callback`). You'll also need at least one demo account linked to your cTID to test against — start on `SpotwareHost.DEMO`, not `SpotwareHost.LIVE`, until you're confident in your integration.

## Quick start

The fastest way to see it working end to end — browser login and all — is the included example:

```bash
git clone git@github.com:caiusCitiriga/ctrader-x.git
cd ctrader-x
npm install
npm start
```

### Connecting in your own code

Once you have an access token and know which account you're connecting to (see [Authenticating](#authenticating-for-the-first-time) below), connecting is this:

```typescript
import { SpotwareClient, SpotwareHost, SpotwareOAuthClient, SpotwareTransport } from 'ctrader-x';

const oauthClient = new SpotwareOAuthClient({ clientId, clientSecret });

const client = new SpotwareClient({
    transport: new SpotwareTransport({ host: SpotwareHost.DEMO }),
    oauthClient,
    clientId,
    clientSecret,
    ctidTraderAccountId, // the account you're connecting to
    token // { accessToken, refreshToken, tokenType, expiresIn }
});

await client.connect();
```

That's it — `client` re-authenticates automatically after every reconnect and refreshes the token when it's close to expiring. It's now ready to use with the `market-data` and `trading` modules below.

### Authenticating for the first time

Getting that `token` and `ctidTraderAccountId` the very first time is a one-time OAuth2 flow, not something you do on every run:

1. Build an authorization URL and send the user to it in a browser.
2. They log into cTrader and approve access; cTrader redirects back to your `redirectUri` with a `code` query param.
3. Exchange that code for a token.
4. Ask the server which account(s) that token can access, and pick one.

```typescript
const oauthClient = new SpotwareOAuthClient({ clientId, clientSecret });
const authorizeUrl = oauthClient.buildAuthorizationUrl({ redirectUri, scope: SpotwareOAuthScope.TRADING });
// open authorizeUrl in a browser, then capture the `code` param cTrader redirects back with
const token = await oauthClient.exchangeAuthorizationCode({ code, redirectUri });
```

Step 4 (listing accounts) needs a connected `SpotwareTransport` and a `SpotwareSocketAuthenticator` — rather than duplicate that here, see [`src/example/shared/create-authenticated-client.ts`](src/example/shared/create-authenticated-client.ts) for the complete, runnable version: capturing the redirect with a local HTTP server, discovering linked accounts, and persisting the token to disk. Refresh tokens are single-use, so save the replacement `token` every time `client.on('tokenRefreshed', ...)` fires, or the next run will fail.

## Architecture

Dependencies only flow one direction, top to bottom in this table: `trading` and `market-data` depend on `client`, which depends on `transport` and `auth`, which depends on `types`. It never goes the other way — `types` has no idea `trading` exists.

| Module        | Depends on       | Responsibility                                                                          |
| ------------- | ----------------- | ---------------------------------------------------------------------------------------- |
| `types`       | —                  | Generated TypeScript types for every Open API Protobuf message.                          |
| `transport`   | `types`            | TCP/TLS connection, message framing, reconnection, rate limiting.                        |
| `auth`        | `transport`        | OAuth2 token flow and the socket-level auth handshake.                                   |
| `client`      | `transport`, `auth`| Request/response correlation, re-auth on reconnect, token refresh.                       |
| `market-data` | `client`           | Symbol lookup and spot price subscriptions.                                              |
| `trading`     | `client`           | Order placement, amendment, cancellation, and position/order queries.                    |

## Usage

### Market data

```typescript
import { SpotwareMarketData } from 'ctrader-x';

const marketData = new SpotwareMarketData(client);

marketData.on('price', (update) => {
    console.log(`${update.symbolId}: bid=${update.bid} ask=${update.ask}`);
});

const symbol = await marketData.symbols.findByName('EURUSD');
if (symbol) {
    await marketData.subscribe(symbol.symbolId);
}
```

`marketData.symbols` is a `SpotwareSymbolCatalog` — it can also be used on its own (`new SpotwareSymbolCatalog(client)`) if you only need symbol lookups.

`findByName`/`getAll` return the light symbol list — enough to resolve a name to a `symbolId` and subscribe. For the trading constraints that list doesn't carry (`lotSize`, `minVolume`/`maxVolume`/`stepVolume`, `digits`, `pipPosition`), fetch the full spec:

```typescript
const fullSymbol = await marketData.symbols.getFullSymbol(symbol.symbolId);
```

See [A note on volume](#a-note-on-volume) under Trading for why these matter before placing an order.

### Trading

```typescript
import { SpotwareTrading, ProtoOATradeSide } from 'ctrader-x';

const trading = new SpotwareTrading(client);

const execution = await trading.placeMarketOrder({
    symbolId: symbol.symbolId,
    tradeSide: ProtoOATradeSide.BUY,
    volume: 1000 // 1000 units, not lots — see "A note on volume" below
});

const { positions, orders } = await trading.getOpenPositionsAndOrders();
```

#### A note on volume

`volume` here is in **units** of the symbol's base currency (for EURUSD, 1 unit = 1 EUR), not lots. On the wire, cTrader represents volume as "cents of a unit" — `100000` means `1000.00` units — and `trading` converts to and from that form for you, so you always work in whole units through this API, never the wire's scaled integer.

Units and lots are not the same thing, and the conversion between them is **not a fixed ratio you can hardcode**. How many units make up "1 lot" is defined per symbol, not by the protocol — retail forex conventionally uses 100,000 units per lot, but that's a market convention, not something cTrader's API guarantees for every symbol (it can differ for indices, commodities, crypto, or simply per broker). The authoritative values — `lotSize`, plus the tradable `minVolume`/`maxVolume`/`stepVolume` range — live on the full symbol spec, not the lighter one `getAll()`/`findByName()` return:

```typescript
const fullSymbol = await marketData.symbols.getFullSymbol(symbol.symbolId);
```

If your UI works in lots, or you want to validate a volume before sending it, fetch that spec and convert or check against it before calling `trading`. `ctrader-x` gives you the raw values; it doesn't do that conversion or validation for you.

More complete, runnable examples live in [`src/example/`](src/example/):

```bash
npm run start:market-data   # subscribe to a symbol and print live prices
npm run start:trading       # query positions/orders, place and cancel a safe limit order
```

## Development

### Running tests

```bash
npm test
```

### Building

```bash
npm run build
```

### Regenerating protocol types

`src/types/generated` is produced from Spotware's official `.proto` files in [`proto/`](proto) via `ts-proto`, and is committed to the repo. Whenever `proto/` is refreshed from Spotware's upstream repo, regenerate and commit the diff:

```bash
npm run generate:types
```

## Contributing

Issues and pull requests are welcome. Please open an issue to discuss significant changes before submitting a PR.

## License

[MIT](LICENSE)
