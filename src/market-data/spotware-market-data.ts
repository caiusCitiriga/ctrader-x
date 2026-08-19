import type { SpotwareClient } from '../client';
import { SPOTWARE_PRICE_SCALE } from '../shared/spotware-scale';
import { TypedEventEmitter, type EventMap } from '../shared/typed-event-emitter';
import {
    ProtoMessage,
    ProtoOAGetTrendbarsReq,
    ProtoOAGetTrendbarsRes,
    ProtoOAPayloadType,
    ProtoOASpotEvent,
    ProtoOASubscribeSpotsReq,
    ProtoOATrendbar,
    ProtoOATrendbarPeriod,
    ProtoOAUnsubscribeSpotsReq
} from '../types';
import { SpotwareSymbolCatalog } from './spotware-symbol-catalog';

export interface ISpotwarePriceUpdate {
    symbolId: number;
    bid?: number;
    ask?: number;
    timestamp?: number;
}

export interface ISpotwareMarketDataEvents extends EventMap {
    price: [update: ISpotwarePriceUpdate];
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
 * Subscribes to spot prices via `client` and exposes them as a clean 'price' event, decimal
 * bid/ask already converted. Re-subscribes to everything currently subscribed whenever
 * `client` re-authenticates (including after a reconnect), since a fresh TCP connection has
 * no memory of prior subscriptions.
 */
export class SpotwareMarketData extends TypedEventEmitter<ISpotwareMarketDataEvents> {
    readonly symbols: SpotwareSymbolCatalog;

    private readonly client: SpotwareClient;
    private readonly subscribedSymbolIds = new Set<number>();

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
                ProtoOASubscribeSpotsReq.fromPartial({ ctidTraderAccountId: this.client.ctidTraderAccountId, symbolId: [symbolId] })
            ).finish()
        );

        this.subscribedSymbolIds.add(symbolId);
    }

    async unsubscribe(symbol: number | string): Promise<void> {
        const symbolId = await this.resolveSymbolId(symbol);

        await this.client.send(
            ProtoOAPayloadType.PROTO_OA_UNSUBSCRIBE_SPOTS_REQ,
            ProtoOAUnsubscribeSpotsReq.encode(
                ProtoOAUnsubscribeSpotsReq.fromPartial({ ctidTraderAccountId: this.client.ctidTraderAccountId, symbolId: [symbolId] })
            ).finish()
        );

        this.subscribedSymbolIds.delete(symbolId);
    }

    /** Fetches historical bars — a one-off request, not a subscription. */
    async getTrendbars(params: IGetTrendbarsParams): Promise<ITrendbar[]> {
        const request = ProtoOAGetTrendbarsReq.fromPartial({
            ctidTraderAccountId: this.client.ctidTraderAccountId,
            symbolId: params.symbolId,
            period: params.period,
            fromTimestamp: params.fromTimestamp,
            toTimestamp: params.toTimestamp,
            count: params.count
        });

        const response = await this.client.send(ProtoOAPayloadType.PROTO_OA_GET_TRENDBARS_REQ, encodeGetTrendbarsReq(request));

        return ProtoOAGetTrendbarsRes.decode(response.payload ?? new Uint8Array()).trendbar.map(toCleanTrendbar);
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
        if (message.payloadType !== ProtoOAPayloadType.PROTO_OA_SPOT_EVENT) {
            return;
        }

        const event = ProtoOASpotEvent.decode(message.payload ?? new Uint8Array());

        this.emit('price', {
            symbolId: event.symbolId,
            bid: event.bid === undefined ? undefined : event.bid / SPOTWARE_PRICE_SCALE,
            ask: event.ask === undefined ? undefined : event.ask / SPOTWARE_PRICE_SCALE,
            timestamp: event.timestamp
        });
    }

    private resubscribeAll(): void {
        if (this.subscribedSymbolIds.size === 0) {
            return;
        }

        const symbolId = [...this.subscribedSymbolIds];

        this.client
            .send(
                ProtoOAPayloadType.PROTO_OA_SUBSCRIBE_SPOTS_REQ,
                ProtoOASubscribeSpotsReq.encode(
                    ProtoOASubscribeSpotsReq.fromPartial({ ctidTraderAccountId: this.client.ctidTraderAccountId, symbolId })
                ).finish()
            )
            .catch((error: Error) => this.emit('error', error));
    }
}

// ts-proto skips a required field on the wire whenever its value equals the field's implicit
// proto2 default — for an enum with no explicit `[default = ...]` annotation, that's always its
// first declared member. `period` has no such annotation, so M1 (1) — the single most common
// period to request — gets silently dropped, the same class of bug fixed for orderType/tradeSide
// in the trading module. Field order doesn't matter on the wire, so appending it after the
// normal encode is a safe, minimal fix that doesn't require hand-editing generated code.
function encodeGetTrendbarsReq(request: ProtoOAGetTrendbarsReq): Uint8Array {
    const writer = ProtoOAGetTrendbarsReq.encode(request);

    if (request.period === ProtoOATrendbarPeriod.M1) {
        writer.uint32(40).int32(request.period);
    }

    return writer.finish();
}

// Bar prices are delta-encoded off `low` and fixed-point scaled, confirmed against cTrader's
// own help center docs (not assumed): open = (low + deltaOpen) / scale, etc.
function toCleanTrendbar(trendbar: ProtoOATrendbar): ITrendbar {
    const low = trendbar.low ?? 0;

    return {
        period: trendbar.period ?? ProtoOATrendbarPeriod.M1,
        timestamp: trendbar.utcTimestampInMinutes === undefined ? undefined : trendbar.utcTimestampInMinutes * 60_000,
        low: low / SPOTWARE_PRICE_SCALE,
        open: (low + (trendbar.deltaOpen ?? 0)) / SPOTWARE_PRICE_SCALE,
        high: (low + (trendbar.deltaHigh ?? 0)) / SPOTWARE_PRICE_SCALE,
        close: (low + (trendbar.deltaClose ?? 0)) / SPOTWARE_PRICE_SCALE,
        volume: trendbar.volume
    };
}
