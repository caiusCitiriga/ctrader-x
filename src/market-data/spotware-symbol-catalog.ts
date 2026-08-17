import type { SpotwareClient } from '../client';
import {
    ProtoOALightSymbol,
    ProtoOAPayloadType,
    ProtoOASymbol,
    ProtoOASymbolByIdReq,
    ProtoOASymbolByIdRes,
    ProtoOASymbolsListReq,
    ProtoOASymbolsListRes
} from '../types';

/**
 * Fetches and caches the account's symbol list, and resolves a ticker name (e.g. "EURUSD")
 * to the numeric symbolId every other request actually needs. Public on its own — trading
 * will want the same lookups later — and used internally by SpotwareMarketData so callers
 * can subscribe by name without touching this class directly.
 */
export class SpotwareSymbolCatalog {
    private symbolsPromise: Promise<ProtoOALightSymbol[]> | undefined;
    private readonly fullSymbolPromises = new Map<number, Promise<ProtoOASymbol | undefined>>();

    constructor(private readonly client: SpotwareClient) {}

    async getAll(): Promise<ProtoOALightSymbol[]> {
        if (!this.symbolsPromise) {
            this.symbolsPromise = this.fetchSymbols();
        }

        return this.symbolsPromise;
    }

    async findByName(symbolName: string): Promise<ProtoOALightSymbol | undefined> {
        const normalized = symbolName.trim().toUpperCase();
        const symbols = await this.getAll();

        return symbols.find((symbol) => symbol.symbolName?.toUpperCase() === normalized);
    }

    async findById(symbolId: number): Promise<ProtoOALightSymbol | undefined> {
        const symbols = await this.getAll();

        return symbols.find((symbol) => symbol.symbolId === symbolId);
    }

    // Forces a re-fetch, e.g. if symbols were added or archived since the last load.
    refresh(): Promise<ProtoOALightSymbol[]> {
        this.symbolsPromise = this.fetchSymbols();

        return this.symbolsPromise;
    }

    /**
     * Fetches the full symbol spec — lotSize, minVolume/maxVolume/stepVolume, digits,
     * pipPosition, and everything else `getAll()`'s light list doesn't carry. Needed to
     * validate a volume or round a price correctly before placing an order: those constraints
     * are defined per symbol by the broker, not by a fixed, hardcodable ratio.
     */
    async getFullSymbol(symbolId: number): Promise<ProtoOASymbol | undefined> {
        let promise = this.fullSymbolPromises.get(symbolId);
        if (!promise) {
            promise = this.fetchFullSymbol(symbolId);
            this.fullSymbolPromises.set(symbolId, promise);
        }

        return promise;
    }

    private async fetchSymbols(): Promise<ProtoOALightSymbol[]> {
        try {
            const request = ProtoOASymbolsListReq.fromPartial({ ctidTraderAccountId: this.client.ctidTraderAccountId });
            const response = await this.client.send(
                ProtoOAPayloadType.PROTO_OA_SYMBOLS_LIST_REQ,
                ProtoOASymbolsListReq.encode(request).finish()
            );

            return ProtoOASymbolsListRes.decode(response.payload ?? new Uint8Array()).symbol;
        } catch (error) {
            // Don't cache a failure — the next call should retry instead of returning a
            // permanently broken rejected promise.
            this.symbolsPromise = undefined;
            throw error;
        }
    }

    private async fetchFullSymbol(symbolId: number): Promise<ProtoOASymbol | undefined> {
        try {
            const request = ProtoOASymbolByIdReq.fromPartial({ ctidTraderAccountId: this.client.ctidTraderAccountId, symbolId: [symbolId] });
            const response = await this.client.send(ProtoOAPayloadType.PROTO_OA_SYMBOL_BY_ID_REQ, ProtoOASymbolByIdReq.encode(request).finish());

            return ProtoOASymbolByIdRes.decode(response.payload ?? new Uint8Array()).symbol.find((symbol) => symbol.symbolId === symbolId);
        } catch (error) {
            this.fullSymbolPromises.delete(symbolId);
            throw error;
        }
    }
}
