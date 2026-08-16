import * as net from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SpotwareClient } from '../../src/client';
import { SpotwareSymbolCatalog } from '../../src/market-data/spotware-symbol-catalog';
import { ProtoOAPayloadType } from '../../src/types';
import { createTestClient } from '../shared/create-test-client';

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
});
