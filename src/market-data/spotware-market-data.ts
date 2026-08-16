import type { SpotwareClient } from '../client';
import { SPOTWARE_PRICE_SCALE } from '../shared/spotware-scale';
import { TypedEventEmitter, type EventMap } from '../shared/typed-event-emitter';
import { ProtoMessage, ProtoOAPayloadType, ProtoOASpotEvent, ProtoOASubscribeSpotsReq, ProtoOAUnsubscribeSpotsReq } from '../types';
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
