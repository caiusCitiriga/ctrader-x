import * as net from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SpotwareClient } from '../../src/client';
import { SpotwareSymbolCatalog } from '../../src/market-data/spotware-symbol-catalog';
import { ProtoMessage, ProtoOAPayloadType, ProtoOASymbol, ProtoOASymbolByIdReq, ProtoOASymbolByIdRes } from '../../src/types';
import { createTestClient } from '../shared/create-test-client';

function symbolByIdResponse(clientMsgId: string | undefined, symbols: ProtoOASymbol[]): ProtoMessage {
    return ProtoMessage.fromPartial({
        payloadType: ProtoOAPayloadType.PROTO_OA_SYMBOL_BY_ID_RES,
        payload: ProtoOASymbolByIdRes.encode(ProtoOASymbolByIdRes.fromPartial({ symbol: symbols })).finish(),
        clientMsgId
    });
}

describe('SpotwareSymbolCatalog', () => {
    let server: net.Server;
    let port: number;
    let createdClients: SpotwareClient[];

    beforeEach(async () => {
        server = net.createServer();
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        port = (server.address() as net.AddressInfo).port;
        createdClients = [];
    });

    afterEach(async () => {
        await Promise.all(createdClients.map((client) => client.disconnect().catch(() => undefined)));
        await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    it('fetches and caches the symbol list, sending only one request for concurrent calls', async () => {
        let symbolsListRequestCount = 0;
        const { client } = createTestClient(server, port, createdClients, {
            shouldRespond: (request) => {
                if (request.payloadType === ProtoOAPayloadType.PROTO_OA_SYMBOLS_LIST_REQ) {
                    symbolsListRequestCount += 1;
                }
                return true;
            }
        });
        await client.connect();

        const catalog = new SpotwareSymbolCatalog(client);
        const [first, second] = await Promise.all([catalog.getAll(), catalog.getAll()]);

        expect(first).toBe(second);
        expect(first.map((symbol) => symbol.symbolName)).toEqual(['EURUSD', 'GBPUSD']);
        expect(symbolsListRequestCount).toBe(1);
    });

    it('finds a symbol by name, case-insensitively', async () => {
        const { client } = createTestClient(server, port, createdClients);
        await client.connect();

        const catalog = new SpotwareSymbolCatalog(client);
        const found = await catalog.findByName('eurusd');

        expect(found?.symbolId).toBe(1);
    });

    it('finds a symbol by id', async () => {
        const { client } = createTestClient(server, port, createdClients);
        await client.connect();

        const catalog = new SpotwareSymbolCatalog(client);
        const found = await catalog.findById(2);

        expect(found?.symbolName).toBe('GBPUSD');
    });

    it('retries on the next call after a failed fetch, instead of caching the failure', async () => {
        let symbolsListRequestCount = 0;
        const { client } = createTestClient(server, port, createdClients, {
            shouldRespond: (request) => {
                if (request.payloadType === ProtoOAPayloadType.PROTO_OA_SYMBOLS_LIST_REQ) {
                    symbolsListRequestCount += 1;
                    return symbolsListRequestCount > 1; // drop the first attempt, answer from the second onward
                }
                return true;
            }
        });
        (client as unknown as { requestTimeoutMs: number }).requestTimeoutMs = 50;
        await client.connect();

        const catalog = new SpotwareSymbolCatalog(client);

        await expect(catalog.getAll()).rejects.toThrow();
        const symbols = await catalog.getAll();

        expect(symbols).toHaveLength(2);
    });

    it('refresh() re-fetches instead of returning the cached list', async () => {
        let symbolsListRequestCount = 0;
        const { client } = createTestClient(server, port, createdClients, {
            shouldRespond: (request) => {
                if (request.payloadType === ProtoOAPayloadType.PROTO_OA_SYMBOLS_LIST_REQ) {
                    symbolsListRequestCount += 1;
                }
                return true;
            }
        });
        await client.connect();

        const catalog = new SpotwareSymbolCatalog(client);
        await catalog.getAll();
        await catalog.refresh();

        expect(symbolsListRequestCount).toBe(2);
    });

    it('fetches the full symbol spec, including fields the light list does not carry', async () => {
        const requests: ProtoOASymbolByIdReq[] = [];
        const { client } = createTestClient(server, port, createdClients, {
            onOtherRequest: (request) => {
                if (request.payloadType === ProtoOAPayloadType.PROTO_OA_SYMBOL_BY_ID_REQ) {
                    requests.push(ProtoOASymbolByIdReq.decode(request.payload ?? new Uint8Array()));
                    return symbolByIdResponse(
                        request.clientMsgId,
                        [ProtoOASymbol.fromPartial({ symbolId: 1, digits: 5, pipPosition: 4, lotSize: 10_000_00, minVolume: 1_000_00, maxVolume: 5_000_000_00, stepVolume: 1_000_00 })]
                    );
                }
                return undefined;
            }
        });
        await client.connect();

        const catalog = new SpotwareSymbolCatalog(client);
        const symbol = await catalog.getFullSymbol(1);

        expect(requests[0]?.symbolId).toEqual([1]);
        expect(symbol).toMatchObject({ symbolId: 1, digits: 5, pipPosition: 4, lotSize: 1_000_000, minVolume: 100_000 });
    });

    it('caches the full spec per symbolId, sending only one request for concurrent calls', async () => {
        let requestCount = 0;
        const { client } = createTestClient(server, port, createdClients, {
            onOtherRequest: (request) => {
                if (request.payloadType === ProtoOAPayloadType.PROTO_OA_SYMBOL_BY_ID_REQ) {
                    requestCount += 1;
                    return symbolByIdResponse(request.clientMsgId, [ProtoOASymbol.fromPartial({ symbolId: 1, digits: 5, pipPosition: 4 })]);
                }
                return undefined;
            }
        });
        await client.connect();

        const catalog = new SpotwareSymbolCatalog(client);
        const [first, second] = await Promise.all([catalog.getFullSymbol(1), catalog.getFullSymbol(1)]);

        expect(first).toBe(second);
        expect(requestCount).toBe(1);
    });

    it('retries getFullSymbol on the next call after a failed fetch, instead of caching the failure', async () => {
        let requestCount = 0;
        const { client } = createTestClient(server, port, createdClients, {
            shouldRespond: (request) => {
                if (request.payloadType === ProtoOAPayloadType.PROTO_OA_SYMBOL_BY_ID_REQ) {
                    requestCount += 1;
                    return requestCount > 1; // drop the first attempt, answer from the second onward
                }
                return true;
            },
            onOtherRequest: (request) => {
                if (request.payloadType === ProtoOAPayloadType.PROTO_OA_SYMBOL_BY_ID_REQ) {
                    return symbolByIdResponse(request.clientMsgId, [ProtoOASymbol.fromPartial({ symbolId: 1, digits: 5, pipPosition: 4 })]);
                }
                return undefined;
            }
        });
        (client as unknown as { requestTimeoutMs: number }).requestTimeoutMs = 50;
        await client.connect();

        const catalog = new SpotwareSymbolCatalog(client);

        await expect(catalog.getFullSymbol(1)).rejects.toThrow();
        const symbol = await catalog.getFullSymbol(1);

        expect(symbol?.symbolId).toBe(1);
    });

    it('resolves undefined when the requested symbolId is missing from the response', async () => {
        const { client } = createTestClient(server, port, createdClients, {
            onOtherRequest: (request) => {
                if (request.payloadType === ProtoOAPayloadType.PROTO_OA_SYMBOL_BY_ID_REQ) {
                    return symbolByIdResponse(request.clientMsgId, []);
                }
                return undefined;
            }
        });
        await client.connect();

        const catalog = new SpotwareSymbolCatalog(client);

        await expect(catalog.getFullSymbol(999)).resolves.toBeUndefined();
    });
});
