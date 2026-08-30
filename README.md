# CTrader-x

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

Historical bars are a one-off fetch, not a subscription:

```typescript
import { ProtoOATrendbarPeriod } from 'ctrader-x';

const bars = await marketData.getTrendbars({
    symbolId: symbol.symbolId,
    period: ProtoOATrendbarPeriod.H1,
    fromTimestamp: Date.now() - 7 * 24 * 60 * 60 * 1000, // last 7 days
    toTimestamp: Date.now()
});
```

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
npm run start:trendbars     # fetch the last 24h of H1 bars for a symbol
```

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
    on(event: 'disconnected', listener: (reason: SpotwareDisconnectReason) => void): this;
    on(event: 'reconnecting', listener: (attempt: number, delayMs: number) => void): this;
    on(event: 'message', listener: (message: ProtoMessage) => void): this;
    on(event: 'error', listener: (error: Error) => void): this;
}

interface ISpotwareTransportOptions {
    host: SpotwareHost;
    port?: number;                                 // default: SPOTWARE_PORT (5035)
    reconnectBackoff?: IReconnectBackoffOptions;    // default: DEFAULT_RECONNECT_BACKOFF_OPTIONS
    socketFactory?: SpotwareSocketFactory;          // default: real tls.connect; override for testing
    staleConnectionTimeoutMs?: number;              // default: 30000
}
```

- `connect()` rejects if the very first attempt fails — likely a config problem worth surfacing, not something to retry silently. A later reconnect attempt that fails keeps retrying with backoff instead of stopping, since by then the target is already known to be reachable.
- `disconnect()` is an intentional disconnect: no auto-reconnect follows it.
- A liveness watchdog force-reconnects if no data has been received for `staleConnectionTimeoutMs`. A silent network outage produces no socket-level `error`/`close` on its own — TCP only notices once something tries to use the connection, which can take far longer than that timeout.

```typescript
enum SpotwareHost {
    DEMO = 'demo.ctraderapi.com',
    LIVE = 'live.ctraderapi.com'
}
```

| Other export | Description |
| --- | --- |
| `SPOTWARE_PORT` | `5035` — cTrader's Open API TCP port. |
| `IReconnectBackoffOptions` | `{ baseDelayMs, maxDelayMs, factor }` |
| `DEFAULT_RECONNECT_BACKOFF_OPTIONS` | `{ baseDelayMs: 500, maxDelayMs: 30_000, factor: 2 }` |
| `calculateReconnectDelayMs(attempt, options?)` | Pure function computing the next backoff delay, with jitter. |
| `SpotwareSocketFactory` | `(port, host) => Promise<Duplex>` — inject a test double instead of a real socket. |
| `SpotwareDisconnectReason` | `'manual' \| 'dropped'` |

### Auth

#### `SpotwareOAuthClient`

The HTTP half of the OAuth2 flow: authorize URL, code exchange, refresh. Knows nothing about the socket.

```typescript
class SpotwareOAuthClient {
    constructor(options: { clientId: string; clientSecret: string });

    buildAuthorizationUrl(params: { redirectUri: string; scope: SpotwareOAuthScope }): string;
    exchangeAuthorizationCode(params: { code: string; redirectUri: string }): Promise<ISpotwareOAuthToken>;
    refreshAccessToken(params: { refreshToken: string }): Promise<ISpotwareOAuthToken>;
}
```

Throws `SpotwareOAuthError` (`errorCode?: string`, `httpStatus?: number`) on failure. Refresh tokens are single-use — always persist the token returned from a refresh call, not just the original one.

#### `SpotwareSocketAuthenticator`

The socket half of authentication: `ApplicationAuthReq` → `GetAccountListByAccessTokenReq` → `AccountAuthReq`. Requires an already-connected `SpotwareTransport`.

```typescript
class SpotwareSocketAuthenticator {
    constructor(transport: SpotwareTransport, options?: { responseTimeoutMs?: number }); // default: 10000

    authenticateApplication(clientId: string, clientSecret: string): Promise<void>;
    listAccounts(accessToken: string): Promise<ProtoOACtidTraderAccount[]>;
    authenticateAccount(ctidTraderAccountId: number, accessToken: string): Promise<void>;
}
```

Throws `SpotwareSocketAuthError` (`errorCode?: string`) on failure. Most consumers won't call this directly — `SpotwareClient` runs this handshake automatically, including after every reconnect. It's exposed for the one-time account discovery step; see [Authenticating for the first time](#authenticating-for-the-first-time).

| Other export | Description |
| --- | --- |
| `SpotwareOAuthScope` | `enum { ACCOUNTS = 'accounts', TRADING = 'trading' }` |
| `ISpotwareOAuthToken` | `{ accessToken, refreshToken, tokenType, expiresIn }` |
| `SpotwareOAuthError` | `Error` subclass — `errorCode?`, `httpStatus?` |
| `SpotwareSocketAuthError` | `Error` subclass — `errorCode?` |

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
    on(event: 'tokenRefreshed', listener: (token: ISpotwareOAuthToken) => void): this;
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
    requestTimeoutMs?: number;       // default: 10000
    tokenRefreshBufferMs?: number;   // default: 300000 (refresh 5 minutes before expiry)
}
```

- `send()` rejects with `SpotwareRequestError` on a correlated error response, on timeout, or immediately if the connection drops while the request is in flight — it doesn't wait out its own timeout once `transport` already knows the connection is gone.
- The `'message'` event fires for every message received, including ones with no matching pending request (e.g. spot price events). `market-data` and `trading` are built on this.
- Always attach an `'error'` listener — per Node's `EventEmitter` convention, an unlistened `'error'` event throws and crashes the process. `SpotwareClient` forwards `transport`'s errors here too, so this one listener covers both.

| Other export | Description |
| --- | --- |
| `SpotwareRequestError` | `Error` subclass — `errorCode?: string` |

### Market data

#### `SpotwareMarketData`

```typescript
class SpotwareMarketData {
    constructor(client: SpotwareClient, symbolCatalog?: SpotwareSymbolCatalog);

    readonly symbols: SpotwareSymbolCatalog;

    subscribe(symbol: number | string): Promise<void>;   // a symbolId, or a name resolved via `symbols`
    unsubscribe(symbol: number | string): Promise<void>;
    getTrendbars(params: IGetTrendbarsParams): Promise<ITrendbar[]>;   // a one-off fetch, not a subscription

    on(event: 'price', listener: (update: ISpotwarePriceUpdate) => void): this;
    on(event: 'error', listener: (error: Error) => void): this;
}

interface ISpotwarePriceUpdate {
    symbolId: number;
    bid?: number;       // already converted from the wire's fixed-point form
    ask?: number;
    timestamp?: number;
}

interface IGetTrendbarsParams {
    symbolId: number;
    period: ProtoOATrendbarPeriod;
    fromTimestamp?: number;   // Unix ms, must be >= 0
    toTimestamp?: number;     // Unix ms, must be <= 2147483646000 (2038-01-19)
    count?: number;           // caps the number of bars, counting back from toTimestamp
}

interface ITrendbar {
    period: ProtoOATrendbarPeriod;
    timestamp?: number;   // Unix ms, converted from the wire's utcTimestampInMinutes
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
}
```

Re-subscribes to everything currently subscribed whenever `client` re-authenticates (including after a reconnect) — a fresh connection has no memory of prior subscriptions, so without this a reconnect would silently go quiet on price data.

`getTrendbars` fetches historical bars once; it doesn't subscribe to anything ongoing. Bar prices (`open`/`high`/`low`/`close`) are converted for you the same way spot prices are — confirmed against cTrader's own documentation, since the field comments in the underlying Protobuf message don't state the scale themselves.

#### `SpotwareSymbolCatalog`

Public on its own (`new SpotwareSymbolCatalog(client)`), and used internally by `SpotwareMarketData` — `marketData.symbols` is one of these.

```typescript
class SpotwareSymbolCatalog {
    constructor(client: SpotwareClient);

    getAll(): Promise<ProtoOALightSymbol[]>;
    findByName(symbolName: string): Promise<ProtoOALightSymbol | undefined>;   // case-insensitive
    findById(symbolId: number): Promise<ProtoOALightSymbol | undefined>;
    refresh(): Promise<ProtoOALightSymbol[]>;                                  // forces a re-fetch

    getFullSymbol(symbolId: number): Promise<ProtoOASymbol | undefined>;      // lotSize, min/max/stepVolume, digits, pipPosition
}
```

`getAll`/`findByName`/`findById` share one cached fetch; `getFullSymbol` caches per `symbolId`. Neither caches a failure — the next call retries instead of returning a permanently broken promise.

### Trading

#### `SpotwareTrading`

Places/modifies/cancels orders and closes positions, via `client`. Knows nothing about market data streaming.

```typescript
class SpotwareTrading {
    constructor(client: SpotwareClient);

    placeMarketOrder(params: IPlaceMarketOrderParams): Promise<ProtoOAExecutionEvent>;
    placeLimitOrder(params: IPlaceLimitOrderParams): Promise<ProtoOAExecutionEvent>;
    amendOrder(params: IAmendOrderParams): Promise<ProtoOAExecutionEvent>;
    cancelOrder(orderId: number): Promise<ProtoOAExecutionEvent>;
    closePosition(params: IClosePositionParams): Promise<ProtoOAExecutionEvent>;
    getOpenPositionsAndOrders(): Promise<IOpenPositionsAndOrders>;
}

interface IPlaceMarketOrderParams {
    symbolId: number;
    tradeSide: ProtoOATradeSide;
    volume: number;          // in units — see "A note on volume" above
    stopLoss?: number;       // absolute price, not scaled
    takeProfit?: number;     // absolute price, not scaled
    comment?: string;
    label?: string;
}

interface IPlaceLimitOrderParams extends IPlaceMarketOrderParams {
    limitPrice: number;      // absolute price, not scaled
    timeInForce?: ProtoOATimeInForce;
    expirationTimestamp?: number;
}

interface IAmendOrderParams {
    orderId: number;
    volume?: number;         // in units
    limitPrice?: number;
    stopPrice?: number;
    stopLoss?: number;
    takeProfit?: number;
    expirationTimestamp?: number;
}

interface IClosePositionParams {
    positionId: number;
    volume: number;          // in units
}

interface IOpenPositionsAndOrders {
    positions: ProtoOAPosition[];
    orders: ProtoOAOrder[];
}
```

Order mutations have no dedicated response message — the outcome arrives as a `ProtoOAExecutionEvent` on success, and `send()` rejects with `SpotwareRequestError` on failure. Both are already handled for you; these methods just resolve or reject.

### Shared

| Export | Description |
| --- | --- |
| `SPOTWARE_PRICE_SCALE` | `100_000` — the fixed-point scale for bid/ask and relative SL/TP. Not every price field uses it; see [A note on volume](#a-note-on-volume). |
| `SPOTWARE_VOLUME_SCALE` | `100` — the fixed-point scale for volume ("cents of a unit"). |

### Types

Every Protobuf message and enum from Spotware's Open API — `ProtoOANewOrderReq`, `ProtoOATradeSide`, `ProtoOAExecutionEvent`, and roughly 300 more — is generated directly from the official `.proto` files (see [Regenerating protocol types](#regenerating-protocol-types)) and exported from the package root. They aren't listed individually here; each one carries its own field-level doc comments, visible in your editor.

## Quick reference

Everything the package exports, in one place, for when you already know the concepts and just need the signature. The [API Reference](#api-reference) above has the same material with the reasoning behind it.

### Methods

| Class | Member | Description |
| --- | --- | --- |
| `SpotwareTransport` | `connect(): Promise<void>` | Opens the connection. Rejects if the *first* attempt fails; later reconnects keep retrying. |
| | `disconnect(): Promise<void>` | Intentional close — no auto-reconnect follows. |
| | `send(message: ProtoMessage): Promise<void>` | Sends a raw framed message, rate-limited per Spotware's documented limits. |
| `SpotwareOAuthClient` | `buildAuthorizationUrl({ redirectUri, scope }): string` | The URL to send the user to for browser authorization. |
| | `exchangeAuthorizationCode({ code, redirectUri }): Promise<ISpotwareOAuthToken>` | Trades the redirect code for tokens. The code expires in ~1 minute. |
| | `refreshAccessToken({ refreshToken }): Promise<ISpotwareOAuthToken>` | Refresh tokens are single-use — persist what comes back. |
| `SpotwareSocketAuthenticator` | `authenticateApplication(clientId, clientSecret): Promise<void>` | `ApplicationAuthReq`. Once per connection. |
| | `listAccounts(accessToken): Promise<ProtoOACtidTraderAccount[]>` | The only way to discover a `ctidTraderAccountId` from a bare access token. |
| | `authenticateAccount(ctidTraderAccountId, accessToken): Promise<void>` | `AccountAuthReq`. Once per account. |
| `SpotwareClient` | `readonly ctidTraderAccountId: number` | The account this client is bound to. |
| | `connect(): Promise<void>` | Connects and completes the auth handshake. |
| | `disconnect(): Promise<void>` | Closes the underlying transport. |
| | `send(payloadType, payload): Promise<ProtoMessage>` | Correlated request. Rejects with `SpotwareRequestError` on error, timeout, or a drop mid-flight. |
| `SpotwareMarketData` | `readonly symbols: SpotwareSymbolCatalog` | The catalog used to resolve names to ids. |
| | `subscribe(symbol: number \| string): Promise<void>` | By `symbolId` or by name. Re-applied automatically after a reconnect. |
| | `unsubscribe(symbol: number \| string): Promise<void>` | |
| | `getTrendbars(params: IGetTrendbarsParams): Promise<ITrendbar[]>` | One-off historical fetch, not a subscription. Prices already converted. |
| `SpotwareSymbolCatalog` | `getAll(): Promise<ProtoOALightSymbol[]>` | Cached after the first call. |
| | `findByName(symbolName): Promise<ProtoOALightSymbol \| undefined>` | Case-insensitive. |
| | `findById(symbolId): Promise<ProtoOALightSymbol \| undefined>` | |
| | `refresh(): Promise<ProtoOALightSymbol[]>` | Forces a re-fetch of the list. |
| | `getFullSymbol(symbolId): Promise<ProtoOASymbol \| undefined>` | Full spec — `lotSize`, volume bounds, `digits`, `pipPosition`. Cached per id. |
| `SpotwareTrading` | `placeMarketOrder(params): Promise<ProtoOAExecutionEvent>` | |
| | `placeLimitOrder(params): Promise<ProtoOAExecutionEvent>` | |
| | `amendOrder(params): Promise<ProtoOAExecutionEvent>` | |
| | `cancelOrder(orderId): Promise<ProtoOAExecutionEvent>` | |
| | `closePosition(params): Promise<ProtoOAExecutionEvent>` | |
| | `getOpenPositionsAndOrders(): Promise<IOpenPositionsAndOrders>` | |

Constructors: `new SpotwareTransport(options)`, `new SpotwareOAuthClient({ clientId, clientSecret })`, `new SpotwareSocketAuthenticator(transport, options?)`, `new SpotwareClient(options)`, `new SpotwareMarketData(client, symbolCatalog?)`, `new SpotwareSymbolCatalog(client)`, `new SpotwareTrading(client)`.

### Events

Every emitter also exposes `once()` and `off()` with the same signatures as `on()`.

| Class | Event | Listener arguments |
| --- | --- | --- |
| `SpotwareTransport` | `connected` | — |
| | `disconnected` | `(reason: SpotwareDisconnectReason)` |
| | `reconnecting` | `(attempt: number, delayMs: number)` |
| | `message` | `(message: ProtoMessage)` |
| | `error` | `(error: Error)` |
| `SpotwareClient` | `authenticated` | — (fires again after every reconnect) |
| | `tokenRefreshed` | `(token: ISpotwareOAuthToken)` — persist this |
| | `message` | `(message: ProtoMessage)` — every message, correlated or not |
| | `error` | `(error: Error)` — includes forwarded transport errors |
| `SpotwareMarketData` | `price` | `(update: ISpotwarePriceUpdate)` |
| | `error` | `(error: Error)` |

Always attach an `'error'` listener: per Node's `EventEmitter` convention, an unlistened `'error'` event throws and crashes the process.

### Interfaces

| Interface | Shape |
| --- | --- |
| `ISpotwareTransportOptions` | `{ host, port?, reconnectBackoff?, socketFactory?, staleConnectionTimeoutMs? }` |
| `ISpotwareClientOptions` | `{ transport, oauthClient, clientId, clientSecret, ctidTraderAccountId, token, requestTimeoutMs?, tokenRefreshBufferMs? }` |
| `ISpotwareOAuthToken` | `{ accessToken, refreshToken, tokenType, expiresIn }` |
| `IReconnectBackoffOptions` | `{ baseDelayMs, maxDelayMs, factor }` |
| `ISpotwarePriceUpdate` | `{ symbolId, bid?, ask?, timestamp? }` — decimal prices, already unscaled |
| `IGetTrendbarsParams` | `{ symbolId, period, fromTimestamp?, toTimestamp?, count? }` — timestamps in Unix ms |
| `ITrendbar` | `{ period, timestamp?, open, high, low, close, volume }` |
| `IPlaceMarketOrderParams` | `{ symbolId, tradeSide, volume, stopLoss?, takeProfit?, comment?, label? }` — volume in units |
| `IPlaceLimitOrderParams` | `IPlaceMarketOrderParams` + `{ limitPrice, timeInForce?, expirationTimestamp? }` |
| `IAmendOrderParams` | `{ orderId, volume?, limitPrice?, stopPrice?, stopLoss?, takeProfit?, expirationTimestamp? }` |
| `IClosePositionParams` | `{ positionId, volume }` — volume in units |
| `IOpenPositionsAndOrders` | `{ positions: ProtoOAPosition[], orders: ProtoOAOrder[] }` |

### Constants, enums and types

| Export | Value or shape |
| --- | --- |
| `SpotwareHost` | `enum { DEMO = 'demo.ctraderapi.com', LIVE = 'live.ctraderapi.com' }` |
| `SpotwareOAuthScope` | `enum { ACCOUNTS = 'accounts', TRADING = 'trading' }` |
| `SPOTWARE_PORT` | `5035` |
| `SPOTWARE_PRICE_SCALE` | `100_000` |
| `SPOTWARE_VOLUME_SCALE` | `100` |
| `DEFAULT_RECONNECT_BACKOFF_OPTIONS` | `{ baseDelayMs: 500, maxDelayMs: 30_000, factor: 2 }` |
| `calculateReconnectDelayMs(attempt, options?)` | Pure function — next backoff delay, with jitter. |
| `SpotwareDisconnectReason` | `'manual' \| 'dropped'` |
| `SpotwareSocketFactory` | `(port: number, host: string) => Promise<Duplex>` |

### Errors

All extend `Error`, so `instanceof` works.

| Error | Extra fields | Thrown by |
| --- | --- | --- |
| `SpotwareOAuthError` | `errorCode?: string`, `httpStatus?: number` | `SpotwareOAuthClient` |
| `SpotwareSocketAuthError` | `errorCode?: string` | `SpotwareSocketAuthenticator` |
| `SpotwareRequestError` | `errorCode?: string` | `SpotwareClient.send()`, and everything built on it |

### Defaults

| Setting | Default | Set via |
| --- | --- | --- |
| Port | `5035` | `ISpotwareTransportOptions.port` |
| Stale connection timeout | `30_000` ms | `ISpotwareTransportOptions.staleConnectionTimeoutMs` |
| Reconnect backoff | `500` ms base, `30_000` ms cap, factor `2` | `ISpotwareTransportOptions.reconnectBackoff` |
| Auth handshake timeout | `10_000` ms | `ISpotwareSocketAuthenticatorOptions.responseTimeoutMs` |
| Request timeout | `10_000` ms | `ISpotwareClientOptions.requestTimeoutMs` |
| Token refresh buffer | `300_000` ms (5 min before expiry) | `ISpotwareClientOptions.tokenRefreshBufferMs` |
| Heartbeat interval | `10_000` ms | not configurable — Spotware requires at least one every 10s |
| Rate limits | 5 req/s historical, 50 req/s everything else | not configurable — enforced automatically, per connection |

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
