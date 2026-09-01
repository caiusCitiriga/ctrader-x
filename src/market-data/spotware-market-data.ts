import type { SpotwareClient } from '../client';
import { appendRequiredEnumIfDropped } from '../shared/proto-required-field';
import { SPOTWARE_PRICE_SCALE } from '../shared/spotware-scale';
import {
    TypedEventEmitter,
    type EventMap,
} from '../shared/typed-event-emitter';
import {
    ProtoMessage,
    ProtoOADepthEvent,
    ProtoOADepthQuote,
    ProtoOAGetTickDataReq,
    ProtoOAGetTickDataRes,
    ProtoOAGetTrendbarsReq,
    ProtoOAGetTrendbarsRes,
    ProtoOAPayloadType,
    ProtoOAQuoteType,
    ProtoOASpotEvent,
    ProtoOASubscribeDepthQuotesReq,
    ProtoOASubscribeLiveTrendbarReq,
    ProtoOASubscribeSpotsReq,
    ProtoOATickData,
    ProtoOATrendbar,
    ProtoOATrendbarPeriod,
    ProtoOAUnsubscribeDepthQuotesReq,
    ProtoOAUnsubscribeLiveTrendbarReq,
    ProtoOAUnsubscribeSpotsReq,
} from '../types';
import { SpotwareSymbolCatalog } from './spotware-symbol-catalog';

export interface ISpotwarePriceUpdate {
    symbolId: number;
    bid?: number;
    ask?: number;
    timestamp?: number;
}

export interface IDepthQuote {
    id: number;
    size: number;
    bid?: number;
    ask?: number;
}

export interface IDepthUpdate {
    symbolId: number;
    /** Quotes added or changed since the last update. */
    newQuotes: IDepthQuote[];
    /** Ids of quotes that have left the book. */
    deletedQuoteIds: number[];
}

export interface ITickDataPoint {
    /** Unix time in milliseconds, already accumulated from the wire's delta encoding. */
    timestamp: number;
    /** Decimal price, already accumulated and unscaled. */
    price: number;
}

export interface ITickDataPage {
    ticks: ITickDataPoint[];
    /** True when the range matched more ticks than the server's chunk size. */
    hasMore: boolean;
}

export interface ISpotwareMarketDataEvents extends EventMap {
    price: [update: ISpotwarePriceUpdate];
    /**
     * A live bar for a symbol/period subscribed via `subscribeLiveTrendbars`. cTrader delivers
     * these inside spot events rather than as their own message, so a bar only arrives when the
     * symbol also ticks.
     */
    trendbar: [symbolId: number, trendbar: ITrendbar];
    depth: [update: IDepthUpdate];
    error: [error: Error];
}

export interface IGetTrendbarsParams {
    symbolId: number;
    period: ProtoOATrendbarPeriod;
    /** Unix time in milliseconds. Must be >= 0. */
    fromTimestamp?: number;
    /** Unix time in milliseconds. Must be <= 2147483646000 (2038-01-19). */
    toTimestamp?: number;
    /** Caps the number of bars returned, counting back from toTimestamp. */
    count?: number;
}

export interface ISubscribeLiveTrendbarsParams {
    symbolId: number;
    period: ProtoOATrendbarPeriod;
}

export interface IGetTickDataParams {
    symbolId: number;
    /** Which side to fetch — ticks are returned for one side per request. */
    type: ProtoOAQuoteType;
    /** Unix time in milliseconds. Must be >= 0. */
    fromTimestamp?: number;
    /** Unix time in milliseconds. Must be <= 2147483646000 (2038-01-19). */
    toTimestamp?: number;
}

export interface ITrendbar {
    period: ProtoOATrendbarPeriod;
    /** Unix time in milliseconds, converted from the wire's utcTimestampInMinutes. */
    timestamp?: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
}

/**
 * Subscribes to spot prices, live bars and depth of market via `client`, exposing each as a
 * clean event with prices already converted to decimals. Re-subscribes to everything currently
 * subscribed whenever `client` re-authenticates (including after a reconnect), since a fresh
 * TCP connection has no memory of prior subscriptions.
 */
export class SpotwareMarketData extends TypedEventEmitter<ISpotwareMarketDataEvents> {
    readonly symbols: SpotwareSymbolCatalog;

    private readonly client: SpotwareClient;
    private readonly subscribedSymbolIds = new Set<number>();
    private readonly subscribedDepthSymbolIds = new Set<number>();
    // Keyed by symbolId:period so a symbol can carry several periods at once, which cTrader
    // treats as independent subscriptions.
    private readonly subscribedTrendbars = new Map<
        string,
        ISubscribeLiveTrendbarsParams
    >();

    constructor(client: SpotwareClient, symbolCatalog?: SpotwareSymbolCatalog) {
        super();
        this.client = client;
        this.symbols = symbolCatalog ?? new SpotwareSymbolCatalog(client);

        this.client.on('message', (message) => this.handleMessage(message));
        this.client.on('authenticated', () => this.resubscribeAll());
    }

    async subscribe(symbol: number | string): Promise<void> {
        const symbolId = await this.resolveSymbolId(symbol);

        await this.client.send(
            ProtoOAPayloadType.PROTO_OA_SUBSCRIBE_SPOTS_REQ,
            ProtoOASubscribeSpotsReq.encode(
                ProtoOASubscribeSpotsReq.fromPartial({
                    ctidTraderAccountId: this.client.ctidTraderAccountId,
                    symbolId: [symbolId],
                }),
            ).finish(),
        );

        this.subscribedSymbolIds.add(symbolId);
    }

    async unsubscribe(symbol: number | string): Promise<void> {
        const symbolId = await this.resolveSymbolId(symbol);

        await this.client.send(
            ProtoOAPayloadType.PROTO_OA_UNSUBSCRIBE_SPOTS_REQ,
            ProtoOAUnsubscribeSpotsReq.encode(
                ProtoOAUnsubscribeSpotsReq.fromPartial({
                    ctidTraderAccountId: this.client.ctidTraderAccountId,
                    symbolId: [symbolId],
                }),
            ).finish(),
        );

        this.subscribedSymbolIds.delete(symbolId);
    }

    /**
     * Streams closed and forming bars as 'trendbar' events. cTrader piggybacks live bars on
     * spot events, so this also requires an active spot subscription for the same symbol —
     * which this method takes care of on your behalf.
     */
    async subscribeLiveTrendbars(
        params: ISubscribeLiveTrendbarsParams,
    ): Promise<void> {
        if (!this.subscribedSymbolIds.has(params.symbolId)) {
            await this.subscribe(params.symbolId);
        }

        await this.client.send(
            ProtoOAPayloadType.PROTO_OA_SUBSCRIBE_LIVE_TRENDBAR_REQ,
            encodeSubscribeLiveTrendbarReq(
                ProtoOASubscribeLiveTrendbarReq.fromPartial({
                    ctidTraderAccountId: this.client.ctidTraderAccountId,
                    symbolId: params.symbolId,
                    period: params.period,
                }),
            ),
        );

        this.subscribedTrendbars.set(trendbarKey(params), { ...params });
    }

    async unsubscribeLiveTrendbars(
        params: ISubscribeLiveTrendbarsParams,
    ): Promise<void> {
        await this.client.send(
            ProtoOAPayloadType.PROTO_OA_UNSUBSCRIBE_LIVE_TRENDBAR_REQ,
            encodeUnsubscribeLiveTrendbarReq(
                ProtoOAUnsubscribeLiveTrendbarReq.fromPartial({
                    ctidTraderAccountId: this.client.ctidTraderAccountId,
                    symbolId: params.symbolId,
                    period: params.period,
                }),
            ),
        );

        this.subscribedTrendbars.delete(trendbarKey(params));
    }

    /** Streams order book changes as 'depth' events. Not every broker offers depth on every symbol. */
    async subscribeDepth(symbol: number | string): Promise<void> {
        const symbolId = await this.resolveSymbolId(symbol);

        await this.client.send(
            ProtoOAPayloadType.PROTO_OA_SUBSCRIBE_DEPTH_QUOTES_REQ,
            ProtoOASubscribeDepthQuotesReq.encode(
                ProtoOASubscribeDepthQuotesReq.fromPartial({
                    ctidTraderAccountId: this.client.ctidTraderAccountId,
                    symbolId: [symbolId],
                }),
            ).finish(),
        );

        this.subscribedDepthSymbolIds.add(symbolId);
    }

    async unsubscribeDepth(symbol: number | string): Promise<void> {
        const symbolId = await this.resolveSymbolId(symbol);

        await this.client.send(
            ProtoOAPayloadType.PROTO_OA_UNSUBSCRIBE_DEPTH_QUOTES_REQ,
            ProtoOAUnsubscribeDepthQuotesReq.encode(
                ProtoOAUnsubscribeDepthQuotesReq.fromPartial({
                    ctidTraderAccountId: this.client.ctidTraderAccountId,
                    symbolId: [symbolId],
                }),
            ).finish(),
        );

        this.subscribedDepthSymbolIds.delete(symbolId);
    }

    /** Fetches historical bars — a one-off request, not a subscription. */
    async getTrendbars(params: IGetTrendbarsParams): Promise<ITrendbar[]> {
        const request = ProtoOAGetTrendbarsReq.fromPartial({
            ctidTraderAccountId: this.client.ctidTraderAccountId,
            symbolId: params.symbolId,
            period: params.period,
            fromTimestamp: params.fromTimestamp,
            toTimestamp: params.toTimestamp,
            count: params.count,
        });

        const response = await this.client.send(
            ProtoOAPayloadType.PROTO_OA_GET_TRENDBARS_REQ,
            encodeGetTrendbarsReq(request),
        );

        return ProtoOAGetTrendbarsRes.decode(
            response.payload ?? new Uint8Array(),
        ).trendbar.map(toCleanTrendbar);
    }

    /** Fetches raw historical ticks for one side of the book, newest first. */
    async getTickData(params: IGetTickDataParams): Promise<ITickDataPage> {
        const request = ProtoOAGetTickDataReq.fromPartial({
            ctidTraderAccountId: this.client.ctidTraderAccountId,
            symbolId: params.symbolId,
            type: params.type,
            fromTimestamp: params.fromTimestamp,
            toTimestamp: params.toTimestamp,
        });

        const response = await this.client.send(
            ProtoOAPayloadType.PROTO_OA_GET_TICKDATA_REQ,
            encodeGetTickDataReq(request),
        );
        const decoded = ProtoOAGetTickDataRes.decode(
            response.payload ?? new Uint8Array(),
        );

        return {
            ticks: accumulateTickData(decoded.tickData),
            hasMore: decoded.hasMore,
        };
    }

    private async resolveSymbolId(symbol: number | string): Promise<number> {
        if (typeof symbol === 'number') {
            return symbol;
        }

        const found = await this.symbols.findByName(symbol);
        if (!found) {
            throw new Error(`Unknown symbol "${symbol}"`);
        }

        return found.symbolId;
    }

    private handleMessage(message: ProtoMessage): void {
        if (message.payloadType === ProtoOAPayloadType.PROTO_OA_SPOT_EVENT) {
            this.handleSpotEvent(
                ProtoOASpotEvent.decode(message.payload ?? new Uint8Array()),
            );
            return;
        }

        if (message.payloadType === ProtoOAPayloadType.PROTO_OA_DEPTH_EVENT) {
            this.handleDepthEvent(
                ProtoOADepthEvent.decode(message.payload ?? new Uint8Array()),
            );
        }
    }

    private handleSpotEvent(event: ProtoOASpotEvent): void {
        this.emit('price', {
            symbolId: event.symbolId,
            bid: toOptionalPrice(event.bid),
            ask: toOptionalPrice(event.ask),
            timestamp: event.timestamp,
        });

        for (const trendbar of event.trendbar) {
            this.emit('trendbar', event.symbolId, toCleanTrendbar(trendbar));
        }
    }

    private handleDepthEvent(event: ProtoOADepthEvent): void {
        this.emit('depth', {
            symbolId: event.symbolId,
            newQuotes: event.newQuotes.map(toCleanDepthQuote),
            deletedQuoteIds: event.deletedQuotes,
        });
    }

    private resubscribeAll(): void {
        this.resubscribeSpots();
        this.resubscribeDepth();
        this.resubscribeTrendbars();
    }

    private resubscribeSpots(): void {
        if (this.subscribedSymbolIds.size === 0) {
            return;
        }

        const symbolId = [...this.subscribedSymbolIds];

        this.client
            .send(
                ProtoOAPayloadType.PROTO_OA_SUBSCRIBE_SPOTS_REQ,
                ProtoOASubscribeSpotsReq.encode(
                    ProtoOASubscribeSpotsReq.fromPartial({
                        ctidTraderAccountId: this.client.ctidTraderAccountId,
                        symbolId,
                    }),
                ).finish(),
            )
            .catch((error: Error) => this.emit('error', error));
    }

    private resubscribeDepth(): void {
        if (this.subscribedDepthSymbolIds.size === 0) {
            return;
        }

        const symbolId = [...this.subscribedDepthSymbolIds];

        this.client
            .send(
                ProtoOAPayloadType.PROTO_OA_SUBSCRIBE_DEPTH_QUOTES_REQ,
                ProtoOASubscribeDepthQuotesReq.encode(
                    ProtoOASubscribeDepthQuotesReq.fromPartial({
                        ctidTraderAccountId: this.client.ctidTraderAccountId,
                        symbolId,
                    }),
                ).finish(),
            )
            .catch((error: Error) => this.emit('error', error));
    }

    // One request per symbol/period pair: unlike spots, the live trendbar request carries a
    // single symbol and a single period, so they cannot be batched.
    private resubscribeTrendbars(): void {
        for (const params of this.subscribedTrendbars.values()) {
            this.client
                .send(
                    ProtoOAPayloadType.PROTO_OA_SUBSCRIBE_LIVE_TRENDBAR_REQ,
                    encodeSubscribeLiveTrendbarReq(
                        ProtoOASubscribeLiveTrendbarReq.fromPartial({
                            ctidTraderAccountId:
                                this.client.ctidTraderAccountId,
                            symbolId: params.symbolId,
                            period: params.period,
                        }),
                    ),
                )
                .catch((error: Error) => this.emit('error', error));
        }
    }
}

// cTrader sends only the side that changed, and a depth quote is either a bid or an ask —
// never both. ts-proto decodes an absent optional scalar as 0 rather than undefined, so
// "this side did not change" and "this side is 0.00" arrive identical. A price of zero is not
// a real quote, so it is reported as absent: emitting 0 instead would put a plausible-looking
// number into spread and mid calculations.
function toOptionalPrice(value: number | undefined): number | undefined {
    return value ? value / SPOTWARE_PRICE_SCALE : undefined;
}

function trendbarKey(params: ISubscribeLiveTrendbarsParams): string {
    return `${params.symbolId}:${params.period}`;
}

// `period` (field 5) is a required enum with no explicit default, so M1 — the single most
// common period to request — is dropped by ts-proto. See appendRequiredEnumIfDropped.
function encodeGetTrendbarsReq(request: ProtoOAGetTrendbarsReq): Uint8Array {
    const writer = ProtoOAGetTrendbarsReq.encode(request);
    appendRequiredEnumIfDropped(
        writer,
        5,
        request.period,
        ProtoOATrendbarPeriod.M1,
    );

    return writer.finish();
}

// Same bug, different field number: `period` is field 3 on both live trendbar requests.
function encodeSubscribeLiveTrendbarReq(
    request: ProtoOASubscribeLiveTrendbarReq,
): Uint8Array {
    const writer = ProtoOASubscribeLiveTrendbarReq.encode(request);
    appendRequiredEnumIfDropped(
        writer,
        3,
        request.period,
        ProtoOATrendbarPeriod.M1,
    );

    return writer.finish();
}

function encodeUnsubscribeLiveTrendbarReq(
    request: ProtoOAUnsubscribeLiveTrendbarReq,
): Uint8Array {
    const writer = ProtoOAUnsubscribeLiveTrendbarReq.encode(request);
    appendRequiredEnumIfDropped(
        writer,
        3,
        request.period,
        ProtoOATrendbarPeriod.M1,
    );

    return writer.finish();
}

// And again for `type` (field 4), whose implicit default BID is the more commonly requested
// side of the two.
function encodeGetTickDataReq(request: ProtoOAGetTickDataReq): Uint8Array {
    const writer = ProtoOAGetTickDataReq.encode(request);
    appendRequiredEnumIfDropped(writer, 4, request.type, ProtoOAQuoteType.BID);

    return writer.finish();
}

// Bar prices are delta-encoded off `low` and fixed-point scaled, confirmed against cTrader's
// own help center docs (not assumed): open = (low + deltaOpen) / scale, etc.
function toCleanTrendbar(trendbar: ProtoOATrendbar): ITrendbar {
    const low = trendbar.low ?? 0;

    return {
        period: trendbar.period ?? ProtoOATrendbarPeriod.M1,
        timestamp:
            trendbar.utcTimestampInMinutes === undefined
                ? undefined
                : trendbar.utcTimestampInMinutes * 60_000,
        low: low / SPOTWARE_PRICE_SCALE,
        open: (low + (trendbar.deltaOpen ?? 0)) / SPOTWARE_PRICE_SCALE,
        high: (low + (trendbar.deltaHigh ?? 0)) / SPOTWARE_PRICE_SCALE,
        close: (low + (trendbar.deltaClose ?? 0)) / SPOTWARE_PRICE_SCALE,
        volume: trendbar.volume,
    };
}

function toCleanDepthQuote(quote: ProtoOADepthQuote): IDepthQuote {
    return {
        id: quote.id,
        size: quote.size,
        bid: toOptionalPrice(quote.bid),
        ask: toOptionalPrice(quote.ask),
    };
}

// Only the first entry carries absolute values; every later one is a delta against its
// predecessor, for both the timestamp and the price. Ticks arrive newest-first, so the deltas
// walk backwards in time and are typically negative.
function accumulateTickData(tickData: ProtoOATickData[]): ITickDataPoint[] {
    let timestamp = 0;
    let tick = 0;

    return tickData.map((point, index) => {
        timestamp = index === 0 ? point.timestamp : timestamp + point.timestamp;
        tick = index === 0 ? point.tick : tick + point.tick;

        return { timestamp, price: tick / SPOTWARE_PRICE_SCALE };
    });
}
