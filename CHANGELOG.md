# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.2] - 2026-09-01

### Changed

- The README now opens with the project logo instead of a plain `# CTrader-x` heading. Two variants are swapped via `<picture>` and `prefers-color-scheme`, because the wordmark is near-invisible against the wrong background. The image sources are absolute `raw.githubusercontent.com` URLs rather than repository-relative paths: `files` limits the published tarball to `dist`, so npm has no local copy of the assets and must resolve the path on its own. Documentation only — no code changes.

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
