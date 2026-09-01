<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/caiusCitiriga/ctrader-x/main/assets/ctrader-x-stacked.png">
    <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/caiusCitiriga/ctrader-x/main/assets/ctrader-x-stacked-light.png">
    <img src="https://raw.githubusercontent.com/caiusCitiriga/ctrader-x/main/assets/ctrader-x-stacked-light.png" alt="CTrader-X" width="320">
  </picture>
</p>

<p align="center">
  A TypeScript SDK for cTrader's Open API — connect, authenticate, stream prices, and trade, with automatic reconnection built in.
</p>

<p align="center">
  <a href="https://github.com/caiusCitiriga/ctrader-x/actions/workflows/ci.yml"><img src="https://github.com/caiusCitiriga/ctrader-x/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://www.npmjs.com/package/ctrader-x"><img src="https://img.shields.io/npm/v/ctrader-x" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/ctrader-x"><img src="https://img.shields.io/npm/dm/ctrader-x" alt="npm downloads"></a>
  <a href="https://www.npmjs.com/package/ctrader-x"><img src="https://img.shields.io/node/v/ctrader-x" alt="node version"></a>
  <img src="https://img.shields.io/npm/types/ctrader-x" alt="TypeScript types">
  <a href="https://github.com/caiusCitiriga/ctrader-x/blob/main/LICENSE"><img src="https://img.shields.io/npm/l/ctrader-x" alt="license"></a>
</p>

## Why

There is no official Spotware SDK for Node.js/TypeScript; official support covers mainly C# and Python. The main community alternative, Mida, went closed-source. Developers integrating the Open API directly hit real, documented friction: a raw TCP/Protobuf protocol with manual message framing, a delegated OAuth2 handshake, and enough moving parts that getting from zero to a connected, authenticated, streaming client takes real effort.

ctrader-x exists to remove that friction: a clean, typed, batteries-included client, with resilience (reconnection, backoff, outage detection) handled for you instead of left as an exercise.

This is a connectivity/SDK library, not a dashboard or a UI. It gives you the building blocks to talk to cTrader's Open API from your own Node.js backend.

## Features

- Fully typed, generated directly from Spotware's official `.proto` definitions — no hand-maintained protocol types to drift out of date.
- A TCP/TLS transport that survives real network outages: automatic reconnection with exponential backoff and jitter, a liveness watchdog that notices a silently dead connection before the OS would, and Spotware's documented rate limits enforced automatically.
- OAuth2 authorization flow plus the socket-level authentication handshake, re-run automatically after every reconnect.
- Request/response correlation, so `client.send(...)` resolves or rejects with the matching response instead of requiring you to track `clientMsgId`s yourself.
- Market data subscriptions — spot prices, live bars and depth of market — with automatic resubscription after a reconnect, plus a symbol catalog you can use standalone.
- Order placement across every order type cTrader supports (market, limit, stop, stop-limit, market-range), amendment, cancellation, position closing, and moving the stops on an already-open position.
- Typed events for everything the server sends unprompted: fills, stop-loss triggers, order rejections, margin calls, and token revocation — so a long-running process sees what happened while it was waiting, not just what it asked for.
- Account state (balance, assets, expected margin, unrealized PnL) with the per-response `moneyDigits` exponent applied for you.
- Historical deals, orders and cash flow, with the server's paging flag surfaced rather than swallowed.

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
import {
    SpotwareClient,
    SpotwareHost,
    SpotwareOAuthClient,
    SpotwareTransport,
} from 'ctrader-x';

const oauthClient = new SpotwareOAuthClient({ clientId, clientSecret });

const client = new SpotwareClient({
    transport: new SpotwareTransport({ host: SpotwareHost.DEMO }),
    oauthClient,
    clientId,
    clientSecret,
    ctidTraderAccountId, // the account you're connecting to
    token, // { accessToken, refreshToken, tokenType, expiresIn }
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
const authorizeUrl = oauthClient.buildAuthorizationUrl({
    redirectUri,
    scope: SpotwareOAuthScope.TRADING,
});
// open authorizeUrl in a browser, then capture the `code` param cTrader redirects back with
const token = await oauthClient.exchangeAuthorizationCode({
    code,
    redirectUri,
});
```

Step 4 (listing accounts) needs a connected `SpotwareTransport` and a `SpotwareSocketAuthenticator` — rather than duplicate that here, see [`src/example/shared/create-authenticated-client.ts`](src/example/shared/create-authenticated-client.ts) for the complete, runnable version: capturing the redirect with a local HTTP server, discovering linked accounts, and persisting the token to disk. Refresh tokens are single-use, so save the replacement `token` every time `client.on('tokenRefreshed', ...)` fires, or the next run will fail.

## Architecture

Dependencies only flow one direction, top to bottom in this table: the domain modules depend on `client`, which depends on `transport` and `auth`, which depends on `types`. It never goes the other way — `types` has no idea `trading` exists.

| Module        | Depends on          | Responsibility                                                          |
| ------------- | ------------------- | ----------------------------------------------------------------------- |
| `types`       | —                   | Generated TypeScript types for every Open API Protobuf message.         |
| `transport`   | `types`             | TCP/TLS connection, message framing, reconnection, rate limiting.       |
| `auth`        | `transport`         | OAuth2 token flow and the socket-level auth handshake.                  |
| `client`      | `transport`, `auth` | Request/response correlation, re-auth on reconnect, token refresh.      |
| `market-data` | `client`            | Symbol lookup, spot/bar/depth subscriptions, historical bars and ticks. |
| `trading`     | `client`            | Order placement, amendment, cancellation, and position/order queries.   |
| `account`     | `client`            | Balance, assets, margin, unrealized PnL, and account-level events.      |
| `history`     | `client`            | Historical deals, orders and cash flow.                                 |

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

Historical bars are a one-off fetch, not a subscription:

```typescript
import { ProtoOATrendbarPeriod } from 'ctrader-x';

const bars = await marketData.getTrendbars({
    symbolId: symbol.symbolId,
    period: ProtoOATrendbarPeriod.H1,
    fromTimestamp: Date.now() - 7 * 24 * 60 * 60 * 1000, // last 7 days
    toTimestamp: Date.now(),
});
```

For bars that keep arriving, subscribe instead. cTrader delivers live bars inside spot events rather than as their own message, so a bar only updates when the symbol ticks — and a trendbar subscription without a spot subscription produces nothing at all. `subscribeLiveTrendbars` takes care of the spot subscription for you:

```typescript
marketData.on('trendbar', (symbolId, bar) => {
    console.log(
        `${symbolId} O=${bar.open} H=${bar.high} L=${bar.low} C=${bar.close}`,
    );
});

await marketData.subscribeLiveTrendbars({
    symbolId: symbol.symbolId,
    period: ProtoOATrendbarPeriod.M1,
});
```

Depth of market works the same way, though not every broker offers it on every symbol:

```typescript
marketData.on('depth', (update) => {
    console.log(
        `+${update.newQuotes.length} -${update.deletedQuoteIds.length}`,
    );
});

await marketData.subscribeDepth(symbol.symbolId);
```

Raw historical ticks come back newest-first. On the wire only the first entry is absolute and every later one is a delta against its predecessor — for both the timestamp and the price — which the SDK accumulates back into absolute values before handing them to you:

```typescript
import { ProtoOAQuoteType } from 'ctrader-x';

const { ticks, hasMore } = await marketData.getTickData({
    symbolId: symbol.symbolId,
    type: ProtoOAQuoteType.BID,
    fromTimestamp: Date.now() - 60 * 60 * 1000,
    toTimestamp: Date.now(),
});
```

`hasMore` means the range matched more ticks than the server's chunk size, so narrow the range and ask again rather than assuming you have them all.

### Trading

```typescript
import { SpotwareTrading, ProtoOATradeSide } from 'ctrader-x';

const trading = new SpotwareTrading(client);

const execution = await trading.placeMarketOrder({
    symbolId: symbol.symbolId,
    tradeSide: ProtoOATradeSide.BUY,
    volume: 1000, // 1000 units, not lots — see "A note on volume" below
});

const { positions, orders } = await trading.getOpenPositionsAndOrders();
```

Every order type cTrader supports has its own method — `placeMarketOrder`, `placeLimitOrder`, `placeStopOrder`, `placeStopLimitOrder` and `placeMarketRangeOrder` — so the order type is never something you set by hand.

Stops on a **pending order** are changed with `amendOrder`. Stops on an **already-open position** are a property of the position itself, and need their own call — this is what you use to trail a stop or pull one up to breakeven:

```typescript
await trading.amendPositionStopLossTakeProfit({
    positionId: position.positionId,
    stopLoss: 1.0812,
    takeProfit: 1.0955,
});
```

#### A note on volume

`volume` here is in **units** of the symbol's base currency (for EURUSD, 1 unit = 1 EUR), not lots. On the wire, cTrader represents volume as "cents of a unit" — `100000` means `1000.00` units — and `trading` converts to and from that form for you, so you always work in whole units through this API, never the wire's scaled integer.

Units and lots are not the same thing, and the conversion between them is **not a fixed ratio you can hardcode**. How many units make up "1 lot" is defined per symbol, not by the protocol — retail forex conventionally uses 100,000 units per lot, but that's a market convention, not something cTrader's API guarantees for every symbol (it can differ for indices, commodities, crypto, or simply per broker). The authoritative values — `lotSize`, plus the tradable `minVolume`/`maxVolume`/`stepVolume` range — live on the full symbol spec, not the lighter one `getAll()`/`findByName()` return:

```typescript
const fullSymbol = await marketData.symbols.getFullSymbol(symbol.symbolId);
```

If your UI works in lots, or you want to validate a volume before sending it, fetch that spec and convert or check against it before calling `trading`. `ctrader-x` gives you the raw values; it doesn't do that conversion or validation for you.

### Events

Awaiting a call tells you the request was **accepted**. What happens next — a pending order filling twenty minutes later, a stop-loss triggering overnight, the broker closing a position on margin — arrives unprompted, with no request to attach it to. Anything long-running should listen for those events rather than rely on returned promises alone.

**Events live on the domain module that owns them, not in one central place.** This is deliberate: it keeps each module's surface coherent and preserves the one-way dependency rule in [Architecture](#architecture). The practical consequence is that you only hear an event if you have constructed the module that owns it — no `SpotwareAccount`, no margin call events, even though the message was on the wire.

| Event                                                 | Fires on             | Carries                                             |
| ----------------------------------------------------- | -------------------- | --------------------------------------------------- |
| `execution`                                           | `SpotwareTrading`    | Every fill, trigger and close on the account.       |
| `orderError`                                          | `SpotwareTrading`    | Order rejections, including ones answering nothing. |
| `price`                                               | `SpotwareMarketData` | Spot bid/ask updates.                               |
| `trendbar`                                            | `SpotwareMarketData` | Live bars for a subscribed symbol/period.           |
| `depth`                                               | `SpotwareMarketData` | Order book changes.                                 |
| `traderUpdated`                                       | `SpotwareAccount`    | New account details — balance, leverage, rights.    |
| `marginChanged`                                       | `SpotwareAccount`    | Margin used by a position, already converted.       |
| `marginCallTriggered`                                 | `SpotwareAccount`    | A margin call firing.                               |
| `marginCallUpdated`                                   | `SpotwareAccount`    | A margin call's threshold changing.                 |
| `accountDisconnected`                                 | `SpotwareAccount`    | Server-side account disconnection.                  |
| `tokenInvalidated`                                    | `SpotwareAccount`    | Access revoked — reconnecting will not help.        |
| `authenticated`, `tokenRefreshed`, `message`, `error` | `SpotwareClient`     | Connection lifecycle.                               |
| `connected`, `disconnected`, `reconnecting`, `error`  | `SpotwareTransport`  | Socket lifecycle.                                   |

```typescript
trading.on('execution', (event) => {
    console.log(
        `execution ${event.executionType} on order ${event.order?.orderId}`,
    );
});

account.on('tokenInvalidated', (accountIds, reason) => {
    console.error('Re-run the OAuth flow:', reason);
});
```

Note that `execution` fires for **all** execution events, including the one that resolves your own `placeMarketOrder` call. That is intentional: a listener should see the account's complete order lifecycle, not only the parts nobody happened to await.

If you would rather have a single firehose than per-module events, `client.on('message', ...)` already gives you one — every decoded `ProtoMessage`, before any module interprets it. You then switch on `payloadType` and decode yourself, which is exactly the work these modules exist to save you.

### Account

```typescript
import { SpotwareAccount } from 'ctrader-x';

const account = new SpotwareAccount(client);

const balance = await account.getBalance(); // already a decimal
const margins = await account.getExpectedMargin({
    symbolId: symbol.symbolId,
    volumes: [1000],
});
const unrealized = await account.getPositionsUnrealizedPnL();
```

Monetary values are transmitted as integers scaled by a per-response exponent (`moneyDigits`), so anything returned as a plain number has already been converted using the exponent from **that same response**. Mixing a converted value with a raw one from `getTrader()` is the easiest way to be off by two orders of magnitude.

cTrader does not transmit equity. It is balance plus the net unrealized PnL of open positions:

```typescript
const equity =
    balance + unrealized.reduce((total, p) => total + p.netUnrealizedPnL, 0);
```

### History

```typescript
import { SpotwareHistory } from 'ctrader-x';

const history = new SpotwareHistory(client);

const { deals, hasMore } = await history.getDeals({
    fromTimestamp: Date.now() - 7 * 24 * 60 * 60 * 1000,
    toTimestamp: Date.now(),
});
```

Deals, not orders, are what actually moved money: one order can produce several deals, and realized PnL is carried on the deal's close detail. `hasMore` means the filter matched more records than the server's chunk size — narrow or advance the range and query again rather than assuming the set is complete.

`getCashFlow` is capped by cTrader at one week per request; asking for a wider range throws a `RangeError` locally rather than waiting out a less obvious server error.

More complete, runnable examples live in [`src/example/`](src/example/):

```bash
npm run start:market-data     # subscribe to a symbol and print live prices
npm run start:trading         # query positions/orders, place and cancel safe limit/stop orders
npm run start:trendbars       # fetch the last 24h of H1 bars for a symbol
npm run start:streaming       # historical ticks, plus live bars and depth of market
npm run start:account         # balance, margin, assets, and account events
npm run start:history         # deals, orders and cash flow
npm run start:position-stops  # opens a real position to demo moving its stops, then closes it
```

Every example except `start:position-stops` is read-only or places orders that cannot fill. `start:position-stops` genuinely opens and closes a position, because moving a stop is only meaningful on a filled trade — it uses the broker's minimum volume and closes what it opens. All of them refuse to run against anything but a demo account.

## API Reference

Everything below is exported from the package root (`import { ... } from 'ctrader-x'`). For a signatures-only cheat sheet, skip to [Quick reference](#quick-reference). Classes with events expose `once()` and `off()` with the same signatures as `on()`. The generated Protobuf message and enum types (`ProtoOA...`, `Proto...` — roughly 300 of them) aren't listed individually; see [Types](#types) at the end.

### Transport

#### `SpotwareTransport`

Opens the TCP/TLS connection, frames Protobuf messages on the wire, and auto-reconnects with backoff on any drop that wasn't requested via `disconnect()`.

```typescript
class SpotwareTransport {
    constructor(options: ISpotwareTransportOptions);

    connect(): Promise<void>;
    disconnect(): Promise<void>;
    send(message: ProtoMessage): Promise<void>;

    on(event: 'connected', listener: () => void): this;
    on(
        event: 'disconnected',
        listener: (reason: SpotwareDisconnectReason) => void,
    ): this;
    on(
        event: 'reconnecting',
        listener: (attempt: number, delayMs: number) => void,
    ): this;
    on(event: 'message', listener: (message: ProtoMessage) => void): this;
    on(event: 'error', listener: (error: Error) => void): this;
}

interface ISpotwareTransportOptions {
    host: SpotwareHost;
    port?: number; // default: SPOTWARE_PORT (5035)
    reconnectBackoff?: IReconnectBackoffOptions; // default: DEFAULT_RECONNECT_BACKOFF_OPTIONS
    socketFactory?: SpotwareSocketFactory; // default: real tls.connect; override for testing
    staleConnectionTimeoutMs?: number; // default: 30000
}
```

- `connect()` rejects if the very first attempt fails — likely a config problem worth surfacing, not something to retry silently. A later reconnect attempt that fails keeps retrying with backoff instead of stopping, since by then the target is already known to be reachable.
- `disconnect()` is an intentional disconnect: no auto-reconnect follows it.
- A liveness watchdog force-reconnects if no data has been received for `staleConnectionTimeoutMs`. A silent network outage produces no socket-level `error`/`close` on its own — TCP only notices once something tries to use the connection, which can take far longer than that timeout.

```typescript
enum SpotwareHost {
    DEMO = 'demo.ctraderapi.com',
    LIVE = 'live.ctraderapi.com',
}
```

| Other export                                   | Description                                                                        |
| ---------------------------------------------- | ---------------------------------------------------------------------------------- |
| `SPOTWARE_PORT`                                | `5035` — cTrader's Open API TCP port.                                              |
| `IReconnectBackoffOptions`                     | `{ baseDelayMs, maxDelayMs, factor }`                                              |
| `DEFAULT_RECONNECT_BACKOFF_OPTIONS`            | `{ baseDelayMs: 500, maxDelayMs: 30_000, factor: 2 }`                              |
| `calculateReconnectDelayMs(attempt, options?)` | Pure function computing the next backoff delay, with jitter.                       |
| `SpotwareSocketFactory`                        | `(port, host) => Promise<Duplex>` — inject a test double instead of a real socket. |
| `SpotwareDisconnectReason`                     | `'manual' \| 'dropped'`                                                            |

### Auth

#### `SpotwareOAuthClient`

The HTTP half of the OAuth2 flow: authorize URL, code exchange, refresh. Knows nothing about the socket.

```typescript
class SpotwareOAuthClient {
    constructor(options: { clientId: string; clientSecret: string });

    buildAuthorizationUrl(params: {
        redirectUri: string;
        scope: SpotwareOAuthScope;
    }): string;
    exchangeAuthorizationCode(params: {
        code: string;
        redirectUri: string;
    }): Promise<ISpotwareOAuthToken>;
    refreshAccessToken(params: {
        refreshToken: string;
    }): Promise<ISpotwareOAuthToken>;
}
```

Throws `SpotwareOAuthError` (`errorCode?: string`, `httpStatus?: number`) on failure. Refresh tokens are single-use — always persist the token returned from a refresh call, not just the original one.

#### `SpotwareSocketAuthenticator`

The socket half of authentication: `ApplicationAuthReq` → `GetAccountListByAccessTokenReq` → `AccountAuthReq`. Requires an already-connected `SpotwareTransport`.

```typescript
class SpotwareSocketAuthenticator {
    constructor(
        transport: SpotwareTransport,
        options?: { responseTimeoutMs?: number },
    ); // default: 10000

    authenticateApplication(
        clientId: string,
        clientSecret: string,
    ): Promise<void>;
    listAccounts(accessToken: string): Promise<ProtoOACtidTraderAccount[]>;
    authenticateAccount(
        ctidTraderAccountId: number,
        accessToken: string,
    ): Promise<void>;
}
```

Throws `SpotwareSocketAuthError` (`errorCode?: string`) on failure. Most consumers won't call this directly — `SpotwareClient` runs this handshake automatically, including after every reconnect. It's exposed for the one-time account discovery step; see [Authenticating for the first time](#authenticating-for-the-first-time).

| Other export              | Description                                           |
| ------------------------- | ----------------------------------------------------- |
| `SpotwareOAuthScope`      | `enum { ACCOUNTS = 'accounts', TRADING = 'trading' }` |
| `ISpotwareOAuthToken`     | `{ accessToken, refreshToken, tokenType, expiresIn }` |
| `SpotwareOAuthError`      | `Error` subclass — `errorCode?`, `httpStatus?`        |
| `SpotwareSocketAuthError` | `Error` subclass — `errorCode?`                       |

### Client

#### `SpotwareClient`

Request/response correlation on top of `transport` + `auth`: tags each request with a `clientMsgId` and resolves once the matching response arrives. Re-runs the auth handshake on every `transport` `'connected'` event, including reconnects, and refreshes the token when it's close to expiry.

```typescript
class SpotwareClient {
    constructor(options: ISpotwareClientOptions);

    readonly ctidTraderAccountId: number;

    connect(): Promise<void>;
    disconnect(): Promise<void>;
    send(payloadType: number, payload: Uint8Array): Promise<ProtoMessage>;

    on(event: 'authenticated', listener: () => void): this;
    on(
        event: 'tokenRefreshed',
        listener: (token: ISpotwareOAuthToken) => void,
    ): this;
    on(event: 'message', listener: (message: ProtoMessage) => void): this;
    on(event: 'error', listener: (error: Error) => void): this;
}

interface ISpotwareClientOptions {
    transport: SpotwareTransport;
    oauthClient: SpotwareOAuthClient;
    clientId: string;
    clientSecret: string;
    ctidTraderAccountId: number;
    token: ISpotwareOAuthToken;
    requestTimeoutMs?: number; // default: 10000
    tokenRefreshBufferMs?: number; // default: 300000 (refresh 5 minutes before expiry)
}
```

- `send()` rejects with `SpotwareRequestError` on a correlated error response, on timeout, or immediately if the connection drops while the request is in flight — it doesn't wait out its own timeout once `transport` already knows the connection is gone.
- The `'message'` event fires for every message received, including ones with no matching pending request (e.g. spot price events). `market-data` and `trading` are built on this.
- Always attach an `'error'` listener — per Node's `EventEmitter` convention, an unlistened `'error'` event throws and crashes the process. `SpotwareClient` forwards `transport`'s errors here too, so this one listener covers both.

| Other export           | Description                             |
| ---------------------- | --------------------------------------- |
| `SpotwareRequestError` | `Error` subclass — `errorCode?: string` |

### Market data

#### `SpotwareMarketData`

```typescript
class SpotwareMarketData {
    constructor(client: SpotwareClient, symbolCatalog?: SpotwareSymbolCatalog);

    readonly symbols: SpotwareSymbolCatalog;

    subscribe(symbol: number | string): Promise<void>; // a symbolId, or a name resolved via `symbols`
    unsubscribe(symbol: number | string): Promise<void>;
    subscribeLiveTrendbars(
        params: ISubscribeLiveTrendbarsParams,
    ): Promise<void>; // also subscribes to spots
    unsubscribeLiveTrendbars(
        params: ISubscribeLiveTrendbarsParams,
    ): Promise<void>;
    subscribeDepth(symbol: number | string): Promise<void>;
    unsubscribeDepth(symbol: number | string): Promise<void>;
    getTrendbars(params: IGetTrendbarsParams): Promise<ITrendbar[]>; // a one-off fetch, not a subscription
    getTickData(params: IGetTickDataParams): Promise<ITickDataPage>;

    on(event: 'price', listener: (update: ISpotwarePriceUpdate) => void): this;
    on(
        event: 'trendbar',
        listener: (symbolId: number, trendbar: ITrendbar) => void,
    ): this;
    on(event: 'depth', listener: (update: IDepthUpdate) => void): this;
    on(event: 'error', listener: (error: Error) => void): this;
}

interface ISpotwarePriceUpdate {
    symbolId: number;
    bid?: number; // already converted from the wire's fixed-point form
    ask?: number;
    timestamp?: number;
}

interface IGetTrendbarsParams {
    symbolId: number;
    period: ProtoOATrendbarPeriod;
    fromTimestamp?: number; // Unix ms, must be >= 0
    toTimestamp?: number; // Unix ms, must be <= 2147483646000 (2038-01-19)
    count?: number; // caps the number of bars, counting back from toTimestamp
}

interface ITrendbar {
    period: ProtoOATrendbarPeriod;
    timestamp?: number; // Unix ms, converted from the wire's utcTimestampInMinutes
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
}

interface ISubscribeLiveTrendbarsParams {
    symbolId: number;
    period: ProtoOATrendbarPeriod;
}

interface IGetTickDataParams {
    symbolId: number;
    type: ProtoOAQuoteType; // ticks come back for one side per request
    fromTimestamp?: number;
    toTimestamp?: number;
}

interface ITickDataPage {
    ticks: ITickDataPoint[]; // newest first
    hasMore: boolean;
}

interface ITickDataPoint {
    timestamp: number; // Unix ms, accumulated from the wire's delta encoding
    price: number; // decimal, accumulated and unscaled
}

interface IDepthUpdate {
    symbolId: number;
    newQuotes: IDepthQuote[];
    deletedQuoteIds: number[];
}

interface IDepthQuote {
    id: number;
    size: number;
    bid?: number; // a quote is a bid or an ask, never both
    ask?: number;
}
```

Re-subscribes to everything currently subscribed whenever `client` re-authenticates (including after a reconnect) — a fresh connection has no memory of prior subscriptions, so without this a reconnect would silently go quiet on price data.

`getTrendbars` fetches historical bars once; it doesn't subscribe to anything ongoing. Bar prices (`open`/`high`/`low`/`close`) are converted for you the same way spot prices are — confirmed against cTrader's own documentation, since the field comments in the underlying Protobuf message don't state the scale themselves.

`subscribeLiveTrendbars` is the streaming counterpart. cTrader carries live bars inside spot events rather than as their own message type, so it also subscribes to spots for that symbol — without one, the subscription is accepted and then silently produces nothing.

A price field is reported as `undefined`, never as `0`. cTrader omits the side that did not change, and ts-proto decodes an omission as `0`, so the two are indistinguishable on the wire; since a price of zero is not a real quote, it is treated as absent. Emitting `0` instead would put a plausible-looking number into a spread or mid calculation.

#### `SpotwareSymbolCatalog`

Public on its own (`new SpotwareSymbolCatalog(client)`), and used internally by `SpotwareMarketData` — `marketData.symbols` is one of these.

```typescript
class SpotwareSymbolCatalog {
    constructor(client: SpotwareClient);

    getAll(): Promise<ProtoOALightSymbol[]>;
    findByName(symbolName: string): Promise<ProtoOALightSymbol | undefined>; // case-insensitive
    findById(symbolId: number): Promise<ProtoOALightSymbol | undefined>;
    refresh(): Promise<ProtoOALightSymbol[]>; // forces a re-fetch

    getFullSymbol(symbolId: number): Promise<ProtoOASymbol | undefined>; // lotSize, min/max/stepVolume, digits, pipPosition
}
```

`getAll`/`findByName`/`findById` share one cached fetch; `getFullSymbol` caches per `symbolId`. Neither caches a failure — the next call retries instead of returning a permanently broken promise.

### Trading

#### `SpotwareTrading`

Places/modifies/cancels orders and closes positions, via `client`. Knows nothing about market data streaming.

```typescript
class SpotwareTrading {
    constructor(client: SpotwareClient);

    placeMarketOrder(
        params: IPlaceMarketOrderParams,
    ): Promise<ProtoOAExecutionEvent>;
    placeLimitOrder(
        params: IPlaceLimitOrderParams,
    ): Promise<ProtoOAExecutionEvent>;
    placeStopOrder(
        params: IPlaceStopOrderParams,
    ): Promise<ProtoOAExecutionEvent>;
    placeStopLimitOrder(
        params: IPlaceStopLimitOrderParams,
    ): Promise<ProtoOAExecutionEvent>;
    placeMarketRangeOrder(
        params: IPlaceMarketRangeOrderParams,
    ): Promise<ProtoOAExecutionEvent>;
    amendOrder(params: IAmendOrderParams): Promise<ProtoOAExecutionEvent>;
    amendPositionStopLossTakeProfit(
        params: IAmendPositionStopLossTakeProfitParams,
    ): Promise<ProtoOAExecutionEvent>;
    cancelOrder(orderId: number): Promise<ProtoOAExecutionEvent>;
    closePosition(params: IClosePositionParams): Promise<ProtoOAExecutionEvent>;
    getOpenPositionsAndOrders(): Promise<IOpenPositionsAndOrders>;

    on(
        event: 'execution',
        listener: (event: ProtoOAExecutionEvent) => void,
    ): this;
    on(
        event: 'orderError',
        listener: (event: ProtoOAOrderErrorEvent) => void,
    ): this;
}

interface IPlaceMarketOrderParams {
    symbolId: number;
    tradeSide: ProtoOATradeSide;
    volume: number; // in units — see "A note on volume" above
    stopLoss?: number; // absolute price, not scaled
    takeProfit?: number; // absolute price, not scaled
    trailingStopLoss?: boolean;
    guaranteedStopLoss?: boolean; // French Risk / Guaranteed Stop Loss accounts only
    stopTriggerMethod?: ProtoOAOrderTriggerMethod;
    comment?: string;
    label?: string;
    clientOrderId?: string; // echoed back on the resulting order
    positionId?: number; // target an existing position instead of opening one
}

interface IPlaceLimitOrderParams extends IPlaceMarketOrderParams {
    limitPrice: number; // absolute price, not scaled
    timeInForce?: ProtoOATimeInForce;
    expirationTimestamp?: number;
}

interface IPlaceStopOrderParams extends IPlaceMarketOrderParams {
    stopPrice: number; // absolute price, not scaled
    timeInForce?: ProtoOATimeInForce;
    expirationTimestamp?: number;
}

interface IPlaceStopLimitOrderParams extends IPlaceStopOrderParams {
    slippageInPoints?: number; // how far past stopPrice the limit may fill
}

interface IPlaceMarketRangeOrderParams extends IPlaceMarketOrderParams {
    baseSlippagePrice: number; // the quoted price the order is measured against
    slippageInPoints: number;
}

interface IAmendPositionStopLossTakeProfitParams {
    positionId: number;
    stopLoss?: number; // omit to leave unchanged
    takeProfit?: number;
    trailingStopLoss?: boolean;
    guaranteedStopLoss?: boolean;
    stopLossTriggerMethod?: ProtoOAOrderTriggerMethod;
}

interface IAmendOrderParams {
    orderId: number;
    volume?: number; // in units
    limitPrice?: number;
    stopPrice?: number;
    stopLoss?: number;
    takeProfit?: number;
    expirationTimestamp?: number;
}

interface IClosePositionParams {
    positionId: number;
    volume: number; // in units
}

interface IOpenPositionsAndOrders {
    positions: ProtoOAPosition[];
    orders: ProtoOAOrder[];
}
```

Order mutations have no dedicated response message — the outcome arrives as a `ProtoOAExecutionEvent` on success, and `send()` rejects with `SpotwareRequestError` on failure. Both are already handled for you; these methods just resolve or reject.

The resolved value tells you the request was accepted. Everything that happens to the order afterwards arrives on the `execution` event instead — see [Events](#events).

`amendOrder` targets pending orders; `amendPositionStopLossTakeProfit` targets the stops on an open position, which are a property of the position rather than of any order.

### Account

#### `SpotwareAccount`

```typescript
class SpotwareAccount {
    constructor(client: SpotwareClient);

    getTrader(): Promise<ProtoOATrader>; // monetary fields left in raw scaled form
    getBalance(): Promise<number>; // converted with the account's own moneyDigits
    getAssets(): Promise<ProtoOAAsset[]>;
    getExpectedMargin(
        params: IGetExpectedMarginParams,
    ): Promise<IExpectedMargin[]>;
    getPositionsUnrealizedPnL(): Promise<IPositionUnrealizedPnL[]>;
    getMarginCalls(): Promise<ProtoOAMarginCall[]>;

    on(event: 'traderUpdated', listener: (trader: ProtoOATrader) => void): this;
    on(event: 'marginChanged', listener: (change: IMarginChange) => void): this;
    on(
        event: 'marginCallTriggered',
        listener: (marginCall: ProtoOAMarginCall) => void,
    ): this;
    on(
        event: 'marginCallUpdated',
        listener: (marginCall: ProtoOAMarginCall) => void,
    ): this;
    on(event: 'accountDisconnected', listener: () => void): this;
    on(
        event: 'tokenInvalidated',
        listener: (accountIds: number[], reason?: string) => void,
    ): this;
}

interface IGetExpectedMarginParams {
    symbolId: number;
    volumes: number[]; // in units
}

interface IExpectedMargin {
    volume: number; // in units
    buyMargin: number;
    sellMargin: number;
}

interface IPositionUnrealizedPnL {
    positionId: number;
    grossUnrealizedPnL: number;
    netUnrealizedPnL: number;
}

interface IMarginChange {
    positionId: number;
    usedMargin: number;
}
```

Every plain number returned here has been converted with the `moneyDigits` exponent from the same response that carried it. `getTrader()` is the exception — it hands back the raw message, exponent included, for when you need a field this class doesn't convert.

`getTrader()` rejects with `SpotwareRequestError` if the response carries no account details. That is a malformed response rather than a normal absence, so failing beats returning an `undefined` every caller would have to check.

### History

#### `SpotwareHistory`

```typescript
class SpotwareHistory {
    constructor(client: SpotwareClient);

    getDeals(params: IGetDealsParams): Promise<IDealHistoryPage>;
    getDealsByPositionId(
        params: IGetDealsByPositionIdParams,
    ): Promise<IDealHistoryPage>;
    getOrders(params: ITimeRangeParams): Promise<IOrderHistoryPage>;
    getCashFlow(params: ITimeRangeParams): Promise<ProtoOADepositWithdraw[]>;
}

interface ITimeRangeParams {
    fromTimestamp: number; // Unix ms, must be >= 0
    toTimestamp: number; // Unix ms, must be <= 2147483646000 (2038-01-19)
}

interface IGetDealsParams extends ITimeRangeParams {
    maxRows?: number;
}

interface IGetDealsByPositionIdParams extends Partial<ITimeRangeParams> {
    positionId: number;
}

interface IDealHistoryPage {
    deals: ProtoOADeal[];
    hasMore: boolean;
}

interface IOrderHistoryPage {
    orders: ProtoOAOrder[];
    hasMore: boolean;
}
```

`hasMore` is the server telling you the filter matched more records than its chunk size. It is surfaced rather than swallowed because it is the only signal that the range needs narrowing.

`getCashFlow` throws a `RangeError` for a range wider than `MAX_CASH_FLOW_RANGE_MS` (one week) before sending anything, since cTrader rejects it server-side anyway and the local failure is clearer.

### Shared

| Export                  | Description                                                                                                                                 |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `SPOTWARE_PRICE_SCALE`  | `100_000` — the fixed-point scale for bid/ask and relative SL/TP. Not every price field uses it; see [A note on volume](#a-note-on-volume). |
| `SPOTWARE_VOLUME_SCALE` | `100` — the fixed-point scale for volume ("cents of a unit").                                                                               |
| `DEFAULT_MONEY_DIGITS`  | `2` — the exponent assumed when the server reports none for a monetary value.                                                               |
| `fromMoneyDigits`       | `(value, moneyDigits?) => number` — applies a response's `moneyDigits` exponent. Treats `0` and `undefined` alike; see below.               |

`fromMoneyDigits` treats an exponent of `0` as "unspecified" rather than as a literal whole-unit scale. That is forced by the wire format, not a preference: ts-proto decodes an absent optional scalar as `0`, and encoding an explicit `0` produces byte-identical output to omitting it, so the two cases cannot be told apart. Reading `0` literally would silently report balances 100x too large.

### Types

Every Protobuf message and enum from Spotware's Open API — `ProtoOANewOrderReq`, `ProtoOATradeSide`, `ProtoOAExecutionEvent`, and roughly 300 more — is generated directly from the official `.proto` files (see [Regenerating protocol types](#regenerating-protocol-types)) and exported from the package root. They aren't listed individually here; each one carries its own field-level doc comments, visible in your editor.

## Quick reference

Everything the package exports, in one place, for when you already know the concepts and just need the signature. The [API Reference](#api-reference) above has the same material with the reasoning behind it.

### Methods

| Class                         | Member                                                                           | Description                                                                                      |
| ----------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `SpotwareTransport`           | `connect(): Promise<void>`                                                       | Opens the connection. Rejects if the _first_ attempt fails; later reconnects keep retrying.      |
|                               | `disconnect(): Promise<void>`                                                    | Intentional close — no auto-reconnect follows.                                                   |
|                               | `send(message: ProtoMessage): Promise<void>`                                     | Sends a raw framed message, rate-limited per Spotware's documented limits.                       |
| `SpotwareOAuthClient`         | `buildAuthorizationUrl({ redirectUri, scope }): string`                          | The URL to send the user to for browser authorization.                                           |
|                               | `exchangeAuthorizationCode({ code, redirectUri }): Promise<ISpotwareOAuthToken>` | Trades the redirect code for tokens. The code expires in ~1 minute.                              |
|                               | `refreshAccessToken({ refreshToken }): Promise<ISpotwareOAuthToken>`             | Refresh tokens are single-use — persist what comes back.                                         |
| `SpotwareSocketAuthenticator` | `authenticateApplication(clientId, clientSecret): Promise<void>`                 | `ApplicationAuthReq`. Once per connection.                                                       |
|                               | `listAccounts(accessToken): Promise<ProtoOACtidTraderAccount[]>`                 | The only way to discover a `ctidTraderAccountId` from a bare access token.                       |
|                               | `authenticateAccount(ctidTraderAccountId, accessToken): Promise<void>`           | `AccountAuthReq`. Once per account.                                                              |
| `SpotwareClient`              | `readonly ctidTraderAccountId: number`                                           | The account this client is bound to.                                                             |
|                               | `connect(): Promise<void>`                                                       | Connects and completes the auth handshake.                                                       |
|                               | `disconnect(): Promise<void>`                                                    | Closes the underlying transport.                                                                 |
|                               | `send(payloadType, payload): Promise<ProtoMessage>`                              | Correlated request. Rejects with `SpotwareRequestError` on error, timeout, or a drop mid-flight. |
| `SpotwareMarketData`          | `readonly symbols: SpotwareSymbolCatalog`                                        | The catalog used to resolve names to ids.                                                        |
|                               | `subscribe(symbol: number \| string): Promise<void>`                             | By `symbolId` or by name. Re-applied automatically after a reconnect.                            |
|                               | `unsubscribe(symbol: number \| string): Promise<void>`                           |                                                                                                  |
|                               | `subscribeLiveTrendbars(params): Promise<void>`                                  | Streams bars as `trendbar` events. Also subscribes to spots, which live bars ride on.            |
|                               | `unsubscribeLiveTrendbars(params): Promise<void>`                                |                                                                                                  |
|                               | `subscribeDepth(symbol: number \| string): Promise<void>`                        | Streams order book changes as `depth` events. Not offered by every broker.                       |
|                               | `unsubscribeDepth(symbol: number \| string): Promise<void>`                      |                                                                                                  |
|                               | `getTrendbars(params: IGetTrendbarsParams): Promise<ITrendbar[]>`                | One-off historical fetch, not a subscription. Prices already converted.                          |
|                               | `getTickData(params: IGetTickDataParams): Promise<ITickDataPage>`                | Historical ticks, newest first, delta-decoded into absolute timestamps and prices.               |
| `SpotwareSymbolCatalog`       | `getAll(): Promise<ProtoOALightSymbol[]>`                                        | Cached after the first call.                                                                     |
|                               | `findByName(symbolName): Promise<ProtoOALightSymbol \| undefined>`               | Case-insensitive.                                                                                |
|                               | `findById(symbolId): Promise<ProtoOALightSymbol \| undefined>`                   |                                                                                                  |
|                               | `refresh(): Promise<ProtoOALightSymbol[]>`                                       | Forces a re-fetch of the list.                                                                   |
|                               | `getFullSymbol(symbolId): Promise<ProtoOASymbol \| undefined>`                   | Full spec — `lotSize`, volume bounds, `digits`, `pipPosition`. Cached per id.                    |
| `SpotwareTrading`             | `placeMarketOrder(params): Promise<ProtoOAExecutionEvent>`                       |                                                                                                  |
|                               | `placeLimitOrder(params): Promise<ProtoOAExecutionEvent>`                        |                                                                                                  |
|                               | `placeStopOrder(params): Promise<ProtoOAExecutionEvent>`                         | Becomes a market order once price trades through `stopPrice`.                                    |
|                               | `placeStopLimitOrder(params): Promise<ProtoOAExecutionEvent>`                    | Fills as a limit order capped `slippageInPoints` past `stopPrice`.                               |
|                               | `placeMarketRangeOrder(params): Promise<ProtoOAExecutionEvent>`                  | Rejected rather than filled if price moved beyond the slippage range.                            |
|                               | `amendOrder(params): Promise<ProtoOAExecutionEvent>`                             | Pending orders only.                                                                             |
|                               | `amendPositionStopLossTakeProfit(params): Promise<ProtoOAExecutionEvent>`        | Moves the stops on an **open position** — trailing a stop, or going to breakeven.                |
|                               | `cancelOrder(orderId): Promise<ProtoOAExecutionEvent>`                           |                                                                                                  |
|                               | `closePosition(params): Promise<ProtoOAExecutionEvent>`                          |                                                                                                  |
|                               | `getOpenPositionsAndOrders(): Promise<IOpenPositionsAndOrders>`                  | Lags a close by a moment — an immediate query can still show the position.                       |
| `SpotwareAccount`             | `getTrader(): Promise<ProtoOATrader>`                                            | Raw record, monetary fields unconverted. Rejects if the response carries no details.             |
|                               | `getBalance(): Promise<number>`                                                  | Converted with the account's own `moneyDigits`.                                                  |
|                               | `getAssets(): Promise<ProtoOAAsset[]>`                                           |                                                                                                  |
|                               | `getExpectedMargin(params): Promise<IExpectedMargin[]>`                          | Margin required for given volumes, before placing anything.                                      |
|                               | `getPositionsUnrealizedPnL(): Promise<IPositionUnrealizedPnL[]>`                 | Converted. Add to `getBalance()` for equity, which cTrader does not transmit.                    |
|                               | `getMarginCalls(): Promise<ProtoOAMarginCall[]>`                                 |                                                                                                  |
| `SpotwareHistory`             | `getDeals(params): Promise<IDealHistoryPage>`                                    | Deals, not orders, are what moved money.                                                         |
|                               | `getDealsByPositionId(params): Promise<IDealHistoryPage>`                        | Every fill that opened, added to and closed one position.                                        |
|                               | `getOrders(params): Promise<IOrderHistoryPage>`                                  |                                                                                                  |
|                               | `getCashFlow(params): Promise<ProtoOADepositWithdraw[]>`                         | Throws `RangeError` above one week — cTrader's own cap.                                          |

Constructors: `new SpotwareTransport(options)`, `new SpotwareOAuthClient({ clientId, clientSecret })`, `new SpotwareSocketAuthenticator(transport, options?)`, `new SpotwareClient(options)`, `new SpotwareMarketData(client, symbolCatalog?)`, `new SpotwareSymbolCatalog(client)`, `new SpotwareTrading(client)`, `new SpotwareAccount(client)`, `new SpotwareHistory(client)`.

### Events

Every emitter also exposes `once()` and `off()` with the same signatures as `on()`.

| Class                | Event                 | Listener arguments                                           |
| -------------------- | --------------------- | ------------------------------------------------------------ |
| `SpotwareTransport`  | `connected`           | —                                                            |
|                      | `disconnected`        | `(reason: SpotwareDisconnectReason)`                         |
|                      | `reconnecting`        | `(attempt: number, delayMs: number)`                         |
|                      | `message`             | `(message: ProtoMessage)`                                    |
|                      | `error`               | `(error: Error)`                                             |
| `SpotwareClient`     | `authenticated`       | — (fires again after every reconnect)                        |
|                      | `tokenRefreshed`      | `(token: ISpotwareOAuthToken)` — persist this                |
|                      | `message`             | `(message: ProtoMessage)` — every message, correlated or not |
|                      | `error`               | `(error: Error)` — includes forwarded transport errors       |
| `SpotwareMarketData` | `price`               | `(update: ISpotwarePriceUpdate)`                             |
|                      | `trendbar`            | `(symbolId: number, trendbar: ITrendbar)`                    |
|                      | `depth`               | `(update: IDepthUpdate)`                                     |
|                      | `error`               | `(error: Error)`                                             |
| `SpotwareTrading`    | `execution`           | `(event: ProtoOAExecutionEvent)` — every fill/trigger/close  |
|                      | `orderError`          | `(event: ProtoOAOrderErrorEvent)`                            |
| `SpotwareAccount`    | `traderUpdated`       | `(trader: ProtoOATrader)`                                    |
|                      | `marginChanged`       | `(change: IMarginChange)` — amount already converted         |
|                      | `marginCallTriggered` | `(marginCall: ProtoOAMarginCall)`                            |
|                      | `marginCallUpdated`   | `(marginCall: ProtoOAMarginCall)`                            |
|                      | `accountDisconnected` | —                                                            |
|                      | `tokenInvalidated`    | `(accountIds: number[], reason?: string)`                    |

Events are emitted by the module that owns them, so you only receive an event if you have constructed that module — see [Events](#events) for why, and for the `client.on('message', ...)` escape hatch if you want a single stream instead.

Always attach an `'error'` listener: per Node's `EventEmitter` convention, an unlistened `'error'` event throws and crashes the process. The `orderError` event is deliberately not named `error` for this reason — a rejected order should not be able to crash your process.

### Interfaces

| Interface                                | Shape                                                                                                                                                                                  |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ISpotwareTransportOptions`              | `{ host, port?, reconnectBackoff?, socketFactory?, staleConnectionTimeoutMs? }`                                                                                                        |
| `ISpotwareClientOptions`                 | `{ transport, oauthClient, clientId, clientSecret, ctidTraderAccountId, token, requestTimeoutMs?, tokenRefreshBufferMs? }`                                                             |
| `ISpotwareOAuthToken`                    | `{ accessToken, refreshToken, tokenType, expiresIn }`                                                                                                                                  |
| `IReconnectBackoffOptions`               | `{ baseDelayMs, maxDelayMs, factor }`                                                                                                                                                  |
| `ISpotwarePriceUpdate`                   | `{ symbolId, bid?, ask?, timestamp? }` — decimal prices, already unscaled                                                                                                              |
| `IGetTrendbarsParams`                    | `{ symbolId, period, fromTimestamp?, toTimestamp?, count? }` — timestamps in Unix ms                                                                                                   |
| `ITrendbar`                              | `{ period, timestamp?, open, high, low, close, volume }`                                                                                                                               |
| `ISubscribeLiveTrendbarsParams`          | `{ symbolId, period }`                                                                                                                                                                 |
| `IGetTickDataParams`                     | `{ symbolId, type, fromTimestamp?, toTimestamp? }` — one book side per request                                                                                                         |
| `ITickDataPage`                          | `{ ticks: ITickDataPoint[], hasMore }` — newest first                                                                                                                                  |
| `ITickDataPoint`                         | `{ timestamp, price }` — both accumulated from the wire's delta encoding                                                                                                               |
| `IDepthUpdate`                           | `{ symbolId, newQuotes: IDepthQuote[], deletedQuoteIds: number[] }`                                                                                                                    |
| `IDepthQuote`                            | `{ id, size, bid?, ask? }` — a quote is a bid or an ask, never both                                                                                                                    |
| `IPlaceMarketOrderParams`                | `{ symbolId, tradeSide, volume, stopLoss?, takeProfit?, trailingStopLoss?, guaranteedStopLoss?, stopTriggerMethod?, comment?, label?, clientOrderId?, positionId? }` — volume in units |
| `IPlaceLimitOrderParams`                 | `IPlaceMarketOrderParams` + `{ limitPrice, timeInForce?, expirationTimestamp? }`                                                                                                       |
| `IPlaceStopOrderParams`                  | `IPlaceMarketOrderParams` + `{ stopPrice, timeInForce?, expirationTimestamp? }`                                                                                                        |
| `IPlaceStopLimitOrderParams`             | `IPlaceStopOrderParams` + `{ slippageInPoints? }`                                                                                                                                      |
| `IPlaceMarketRangeOrderParams`           | `IPlaceMarketOrderParams` + `{ baseSlippagePrice, slippageInPoints }`                                                                                                                  |
| `IAmendOrderParams`                      | `{ orderId, volume?, limitPrice?, stopPrice?, stopLoss?, takeProfit?, expirationTimestamp? }`                                                                                          |
| `IAmendPositionStopLossTakeProfitParams` | `{ positionId, stopLoss?, takeProfit?, trailingStopLoss?, guaranteedStopLoss?, stopLossTriggerMethod? }`                                                                               |
| `IClosePositionParams`                   | `{ positionId, volume }` — volume in units                                                                                                                                             |
| `IOpenPositionsAndOrders`                | `{ positions: ProtoOAPosition[], orders: ProtoOAOrder[] }`                                                                                                                             |
| `IGetExpectedMarginParams`               | `{ symbolId, volumes: number[] }` — volumes in units                                                                                                                                   |
| `IExpectedMargin`                        | `{ volume, buyMargin, sellMargin }` — converted, volume back in units                                                                                                                  |
| `IPositionUnrealizedPnL`                 | `{ positionId, grossUnrealizedPnL, netUnrealizedPnL }` — converted                                                                                                                     |
| `IMarginChange`                          | `{ positionId, usedMargin }` — converted                                                                                                                                               |
| `ITimeRangeParams`                       | `{ fromTimestamp, toTimestamp }` — Unix ms                                                                                                                                             |
| `IGetDealsParams`                        | `ITimeRangeParams` + `{ maxRows? }`                                                                                                                                                    |
| `IGetDealsByPositionIdParams`            | `{ positionId, fromTimestamp?, toTimestamp? }`                                                                                                                                         |
| `IDealHistoryPage`                       | `{ deals: ProtoOADeal[], hasMore }`                                                                                                                                                    |
| `IOrderHistoryPage`                      | `{ orders: ProtoOAOrder[], hasMore }`                                                                                                                                                  |

### Constants, enums and types

| Export                                         | Value or shape                                                        |
| ---------------------------------------------- | --------------------------------------------------------------------- |
| `SpotwareHost`                                 | `enum { DEMO = 'demo.ctraderapi.com', LIVE = 'live.ctraderapi.com' }` |
| `SpotwareOAuthScope`                           | `enum { ACCOUNTS = 'accounts', TRADING = 'trading' }`                 |
| `SPOTWARE_PORT`                                | `5035`                                                                |
| `SPOTWARE_PRICE_SCALE`                         | `100_000`                                                             |
| `SPOTWARE_VOLUME_SCALE`                        | `100`                                                                 |
| `DEFAULT_MONEY_DIGITS`                         | `2`                                                                   |
| `fromMoneyDigits(value, moneyDigits?)`         | Pure function — applies a response's monetary exponent.               |
| `MAX_CASH_FLOW_RANGE_MS`                       | `604_800_000` (one week) — cTrader's cap on a cash flow query.        |
| `DEFAULT_RECONNECT_BACKOFF_OPTIONS`            | `{ baseDelayMs: 500, maxDelayMs: 30_000, factor: 2 }`                 |
| `calculateReconnectDelayMs(attempt, options?)` | Pure function — next backoff delay, with jitter.                      |
| `SpotwareDisconnectReason`                     | `'manual' \| 'dropped'`                                               |
| `SpotwareSocketFactory`                        | `(port: number, host: string) => Promise<Duplex>`                     |

### Errors

All extend `Error`, so `instanceof` works.

| Error                     | Extra fields                                | Thrown by                                           |
| ------------------------- | ------------------------------------------- | --------------------------------------------------- |
| `SpotwareOAuthError`      | `errorCode?: string`, `httpStatus?: number` | `SpotwareOAuthClient`                               |
| `SpotwareSocketAuthError` | `errorCode?: string`                        | `SpotwareSocketAuthenticator`                       |
| `SpotwareRequestError`    | `errorCode?: string`                        | `SpotwareClient.send()`, and everything built on it |

### Defaults

| Setting                  | Default                                      | Set via                                                     |
| ------------------------ | -------------------------------------------- | ----------------------------------------------------------- |
| Port                     | `5035`                                       | `ISpotwareTransportOptions.port`                            |
| Stale connection timeout | `30_000` ms                                  | `ISpotwareTransportOptions.staleConnectionTimeoutMs`        |
| Reconnect backoff        | `500` ms base, `30_000` ms cap, factor `2`   | `ISpotwareTransportOptions.reconnectBackoff`                |
| Auth handshake timeout   | `10_000` ms                                  | `ISpotwareSocketAuthenticatorOptions.responseTimeoutMs`     |
| Request timeout          | `10_000` ms                                  | `ISpotwareClientOptions.requestTimeoutMs`                   |
| Token refresh buffer     | `300_000` ms (5 min before expiry)           | `ISpotwareClientOptions.tokenRefreshBufferMs`               |
| Heartbeat interval       | `10_000` ms                                  | not configurable — Spotware requires at least one every 10s |
| Rate limits              | 5 req/s historical, 50 req/s everything else | not configurable — enforced automatically, per connection   |

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
