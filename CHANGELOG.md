# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-08-17

### Added

- `types` — TypeScript types generated from Spotware's official Open API v2 `.proto` files via `ts-proto`.
- `transport` — a resilient TCP/TLS connection to cTrader's Open API: length-prefixed Protobuf framing, automatic reconnection with exponential backoff and jitter, a liveness watchdog that detects silent network outages, TCP keepalive, and Spotware's documented per-endpoint rate limits.
- `auth` — the OAuth2 authorization code flow (authorize URL, token exchange, refresh) and the socket-level application/account authentication handshake.
- `client` — request/response correlation by `clientMsgId`, automatic re-authentication after every reconnect, and access token refresh orchestration.
- `market-data` — a standalone symbol catalog (lookup by name or id) and spot price subscriptions with automatic resubscription after a reconnect.
- `trading` — placing market and limit orders, amending and cancelling pending orders, closing positions, and querying open positions and pending orders.
