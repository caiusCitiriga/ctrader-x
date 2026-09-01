# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.2] - 2026-09-02

### Fixed

- **`vitest run` crashed on CI with `ERR_REQUIRE_ESM`, on Node 18.x and 20.x only.** `vitest.config.ts` has no `"type": "module"` in `package.json` to signal it, so Vitest loaded it as CommonJS via `require()` — but Vite 7 (Vitest 3's dependency) is ESM-only. Node 22.12+ can `require()` an ESM module natively, which is why this passed locally and was invisible until CI's Node 18/20 runners hit it. Renamed the config to `vitest.config.mts`, which forces Vite's config loader to treat it as ESM regardless of the package's module type. Verified with `vitest run` and `tsc` on Node 18.14.0, 20.14.0 and 22.19.0 via `nvm`.

## [0.4.1] - 2026-09-02

### Added

- A GitHub Actions CI workflow (`.github/workflows/ci.yml`): on every push/PR to `main`, installs with `npm ci`, checks Prettier formatting, builds (`tsc`), and runs the test suite, across Node 18/20/22 to match the `engines` constraint. A CI badge was added to the README header.

Tooling and documentation only — no code changes.

## [0.4.0] - 2026-09-01

### Added

- **Unsolicited server events, typed and per module.** The SDK previously surfaced one of the thirteen event types cTrader pushes on its own (`ProtoOASpotEvent`); everything else reached callers only as an undecoded `client.on('message')` payload. `SpotwareTrading` now emits `execution` and `orderError`, and a new `SpotwareAccount` emits `traderUpdated`, `marginChanged`, `marginCallTriggered`, `marginCallUpdated`, `accountDisconnected` and `tokenInvalidated`. This is what lets a long-running process see a pending order filling twenty minutes later or a stop-loss triggering overnight — awaiting a place/amend/close call only ever told you the request was _accepted_. Events sit on the module that owns them to preserve the one-way dependency rule, so an event is only delivered if that module has been constructed; `client.on('message')` remains the single-stream escape hatch.
- **`SpotwareAccount`** — `getTrader`, `getBalance`, `getAssets`, `getExpectedMargin`, `getPositionsUnrealizedPnL`, `getMarginCalls`. Balance and margin were previously unreachable, which made position sizing impossible without a second data source. Monetary values are converted with the `moneyDigits` exponent from the response that carried them, since the exponent is per-response rather than fixed like price and volume.
- **`SpotwareHistory`** — `getDeals`, `getDealsByPositionId`, `getOrders`, `getCashFlow`. The server's `hasMore` paging flag is surfaced rather than swallowed, as it is the caller's only signal that a range needs narrowing. `getCashFlow` rejects a range wider than one week locally, matching cTrader's own documented cap.
- **`SpotwareTrading.amendPositionStopLossTakeProfit`** — moves the stops on an already-open position. `amendOrder` targets pending orders, so trailing a stop or moving one to breakeven had no API at all.
- **The remaining order types** — `placeStopOrder`, `placeStopLimitOrder`, `placeMarketRangeOrder`. `placeOrder` was private, so `STOP`, `STOP_LIMIT` and `MARKET_RANGE` were unreachable despite already being modelled. Order placement also accepts `trailingStopLoss`, `guaranteedStopLoss`, `stopTriggerMethod`, `clientOrderId` and `positionId`.
- **`SpotwareMarketData` streaming and history** — `subscribeLiveTrendbars`/`unsubscribeLiveTrendbars`, `subscribeDepth`/`unsubscribeDepth`, and `getTickData`. Live bars and depth are restored after a reconnect alongside spot subscriptions. Because cTrader carries live bars inside spot events rather than as their own message, `subscribeLiveTrendbars` also subscribes to spots — without one, the subscription is accepted and then silently produces nothing. Historical ticks are delta-encoded in both timestamp and price, and are accumulated back into absolute values (verified against a live demo account, since the field comments only document the timestamp).
- An `exports` map, so the package resolves correctly under modern Node and bundler resolution. The build remains CommonJS.

### Fixed

- **A spot event's unchanged side was reported as a price of `0` instead of as absent.** cTrader omits the side that did not move, and ts-proto decodes an omitted optional scalar as `0` rather than `undefined`, so the previous `=== undefined` check never fired: a bid-only tick — the common case — emitted `ask: 0`. Anything computing a spread or a mid from it silently got a plausible-looking wrong number. Prices are now reported as `undefined` when absent, in both spot and depth updates, on the grounds that zero is not a real quote. The same reasoning applies to `moneyDigits`, where an explicit `0` and an omitted field are byte-identical on the wire and both mean "unspecified".
- **`disconnect()` could leak a live connection.** If it was called while a socket was still being established — the realistic case being a shutdown during a reconnect — it found no socket to destroy and returned immediately, and the connection that arrived a moment later went live with its heartbeat and liveness watchdog running, with nothing holding a reference to close it. The process would then never go idle. A connection attempt that completes after a disconnect now destroys its own socket. Found via an intermittently hanging test rather than by inspection.
- Four more instances of the `required`-field-at-its-implicit-default bug that already affected `orderType`, `tradeSide` and `period`: ts-proto drops the field and the server rejects the message. Confirmed by inspecting raw wire bytes for `subscribeLiveTrendbar.period` and `unsubscribeLiveTrendbar.period` at `M1`, `getTickData.type` at `BID`, and `cashFlowHistory.fromTimestamp` at `0` — each the value a caller would most plausibly pass. The workaround is now a shared helper rather than copied per module.

### Changed

- The README documents events, account state, history, the new order types and streaming, and states explicitly that events live on their owning module rather than in one central place.
- New runnable examples: `start:account`, `start:history`, `start:streaming` and `start:position-stops`. All were executed end-to-end against a live demo account. `start:position-stops` is the only one that genuinely opens a position, which is unavoidable for demonstrating a stop move; it uses the broker's minimum volume and closes what it opens.

## [0.3.2] - 2026-09-01

### Changed

- The README now opens with a centered header — project logo, tagline, and status badges — instead of a plain `# CTrader-x` heading. Two logo variants are swapped via `<picture>` and `prefers-color-scheme`, because the wordmark is near-invisible against the wrong background. Image and link targets are absolute `raw.githubusercontent.com`/`github.com` URLs rather than repository-relative paths: `files` limits the published tarball to `dist`, so npm has no local copy of the assets and must resolve the paths on its own. Badges (version, downloads, supported Node, types, license) are registry-derived and need no CI.
- The lockfile was pinned at `0.3.0` and missing the `engines` constraint — it was never updated when `0.3.1` was released. Regenerated so it matches `package.json`. No dependency versions changed.

Documentation and packaging metadata only — no code changes.

## [0.3.1] - 2026-08-30

### Fixed

- `SpotwareSocketAuthenticator` now tags each handshake request with a `clientMsgId` and ignores responses carrying someone else's, instead of settling on the first message of the expected `payloadType`. Two handshakes can overlap on one socket — a reconnect firing while the previous attempt is still in flight — and both were waiting on the same `payloadType`, so a single response settled both: the attempt that never got a reply reported success and the caller proceeded against an unauthenticated account. Errors that carry no `clientMsgId` at all are still surfaced rather than left to time out, since a connection-level failure can't be attributed to one request.

### Added

- A "Quick reference" section in the README: every exported method, event, interface, constant, error and default in scannable tables, for when you need a signature rather than an explanation.

## [0.3.0] - 2026-08-19

### Added

- `SpotwareMarketData.getTrendbars(params)` — fetches historical bars for a symbol/period (a one-off request, not a subscription). Converts the wire's delta-encoded, fixed-point OHLC (`low` + `deltaOpen`/`deltaHigh`/`deltaClose`, scaled) into a clean `{ open, high, low, close }` shape, confirmed against cTrader's own documentation since the underlying field comments don't state the scale. Also fixes the same class of bug as `SpotwareTrading`'s `orderType`/`tradeSide`: `period` is a required field with no explicit default, so requesting `M1` bars — the most common choice — was silently dropped from the wire by ts-proto's codegen.

## [0.2.0] - 2026-08-17

### Added

- `SpotwareSymbolCatalog.getFullSymbol(symbolId)` — fetches the full per-symbol spec (`lotSize`, `minVolume`/`maxVolume`/`stepVolume`, `digits`, `pipPosition`, and the rest of `ProtoOASymbol`) that the light symbol list used by `getAll()`/`findByName()`/`findById()` doesn't carry. Needed to validate a volume or round a price correctly before placing an order, since those constraints are defined per symbol by the broker, not a fixed ratio. Cached per `symbolId`, with the same dedup-in-flight and don't-cache-failures behavior as the existing symbol list.

## [0.1.0] - 2026-08-17

### Added

- `types` — TypeScript types generated from Spotware's official Open API v2 `.proto` files via `ts-proto`.
- `transport` — a resilient TCP/TLS connection to cTrader's Open API: length-prefixed Protobuf framing, automatic reconnection with exponential backoff and jitter, a liveness watchdog that detects silent network outages, TCP keepalive, and Spotware's documented per-endpoint rate limits.
- `auth` — the OAuth2 authorization code flow (authorize URL, token exchange, refresh) and the socket-level application/account authentication handshake.
- `client` — request/response correlation by `clientMsgId`, automatic re-authentication after every reconnect, and access token refresh orchestration.
- `market-data` — a standalone symbol catalog (lookup by name or id) and spot price subscriptions with automatic resubscription after a reconnect.
- `trading` — placing market and limit orders, amending and cancelling pending orders, closing positions, and querying open positions and pending orders.
