import * as net from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SpotwareClient } from '../../src/client';
import { SpotwareMarketData } from '../../src/market-data/spotware-market-data';
import { encodeFrame } from '../../src/transport/frame-codec';
import {
    ProtoMessage,
    ProtoOAGetTrendbarsReq,
    ProtoOAGetTrendbarsRes,
    ProtoOAPayloadType,
    ProtoOASpotEvent,
    ProtoOASubscribeSpotsReq,
    ProtoOATrendbar,
    ProtoOATrendbarPeriod
} from '../../src/types';
import { createTestClient } from '../shared/create-test-client';

// ts-proto's own decode() defaults an absent required field to the same value encode() skips
// it at, so a round trip through ts-proto on both ends can't detect this bug — only inspecting
// the raw wire bytes (as a stricter real server would) can.
function containsByteSequence(haystack: Uint8Array, needle: number[]): boolean {
    for (let i = 0; i <= haystack.length - needle.length; i += 1) {
        if (needle.every((byte, offset) => haystack[i + offset] === byte)) {
            return true;
        }
    }
    return false;
}

describe('SpotwareMarketData', () => {
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

    it('subscribes by symbolId', async () => {
        const subscribeRequests: ProtoOASubscribeSpotsReq[] = [];
        const { client } = createTestClient(server, port, createdClients, {
            onOtherRequest: (request) => {
                if (request.payloadType === ProtoOAPayloadType.PROTO_OA_SUBSCRIBE_SPOTS_REQ) {
                    subscribeRequests.push(ProtoOASubscribeSpotsReq.decode(request.payload ?? new Uint8Array()));
                }
                return undefined;
            }
        });
        await client.connect();

        const marketData = new SpotwareMarketData(client);
        await marketData.subscribe(1);

        expect(subscribeRequests).toHaveLength(1);
        expect(subscribeRequests[0]?.symbolId).toEqual([1]);
    });

    it('subscribes by symbol name, resolving it via the public symbol catalog', async () => {
        const subscribeRequests: ProtoOASubscribeSpotsReq[] = [];
        const { client } = createTestClient(server, port, createdClients, {
            onOtherRequest: (request) => {
                if (request.payloadType === ProtoOAPayloadType.PROTO_OA_SUBSCRIBE_SPOTS_REQ) {
                    subscribeRequests.push(ProtoOASubscribeSpotsReq.decode(request.payload ?? new Uint8Array()));
                }
                return undefined;
            }
        });
        await client.connect();

        const marketData = new SpotwareMarketData(client);
        await marketData.subscribe('gbpusd');

        expect(subscribeRequests[0]?.symbolId).toEqual([2]);
        // proves it went through the same catalog a consumer could use directly
        expect(await marketData.symbols.findByName('GBPUSD')).toMatchObject({ symbolId: 2 });
    });

    it('rejects subscribing to an unknown symbol name', async () => {
        const { client } = createTestClient(server, port, createdClients);
        await client.connect();

        const marketData = new SpotwareMarketData(client);

        await expect(marketData.subscribe('NOPE')).rejects.toThrow(/unknown symbol/i);
    });

    it('emits "price" with decimal bid/ask for a spot event, and forwards nothing for unrelated messages', async () => {
        const { client, nextServerSocket } = createTestClient(server, port, createdClients);
        const firstConnection = nextServerSocket();
        await client.connect();
        const serverSocket = await firstConnection;

        const marketData = new SpotwareMarketData(client);
        const priceUpdates: unknown[] = [];
        marketData.on('price', (update) => priceUpdates.push(update));

        const spotEvent = ProtoMessage.fromPartial({
            payloadType: ProtoOAPayloadType.PROTO_OA_SPOT_EVENT,
            payload: ProtoOASpotEvent.encode(
                ProtoOASpotEvent.fromPartial({ ctidTraderAccountId: 777, symbolId: 1, bid: 123_000, ask: 123_050, timestamp: 42 })
            ).finish()
        });
        serverSocket.write(encodeFrame(ProtoMessage.encode(spotEvent).finish()));

        await vi.waitFor(() => expect(priceUpdates).toHaveLength(1));
        expect(priceUpdates[0]).toEqual({ symbolId: 1, bid: 1.23, ask: 1.2305, timestamp: 42 });
    });

    it('unsubscribes and stops tracking the symbol for resubscription', async () => {
        const subscribeCount = { value: 0 };
        const { client, nextServerSocket } = createTestClient(server, port, createdClients, {
            onOtherRequest: (request) => {
                if (request.payloadType === ProtoOAPayloadType.PROTO_OA_SUBSCRIBE_SPOTS_REQ) {
                    subscribeCount.value += 1;
                }
                return undefined;
            }
        });
        const firstConnection = nextServerSocket();
        const authenticated = vi.fn();
        client.on('authenticated', authenticated);
        await client.connect();
        const serverSocket = await firstConnection;

        const marketData = new SpotwareMarketData(client);
        await marketData.subscribe(1);
        await marketData.unsubscribe(1);

        expect(subscribeCount.value).toBe(1);

        // trigger a reconnect and confirm it does NOT resubscribe to the now-unsubscribed symbol
        const secondConnection = nextServerSocket();
        serverSocket.destroy();
        await secondConnection;
        await vi.waitFor(() => expect(authenticated).toHaveBeenCalledTimes(2), { timeout: 2000 });

        expect(subscribeCount.value).toBe(1);
    });

    it('resubscribes to previously subscribed symbols after a reconnect', async () => {
        const subscribeRequests: ProtoOASubscribeSpotsReq[] = [];
        const { client, nextServerSocket } = createTestClient(server, port, createdClients, {
            onOtherRequest: (request) => {
                if (request.payloadType === ProtoOAPayloadType.PROTO_OA_SUBSCRIBE_SPOTS_REQ) {
                    subscribeRequests.push(ProtoOASubscribeSpotsReq.decode(request.payload ?? new Uint8Array()));
                }
                return undefined;
            }
        });
        const firstConnection = nextServerSocket();
        await client.connect();
        const serverSocket = await firstConnection;

        const marketData = new SpotwareMarketData(client);
        await marketData.subscribe(1);
        expect(subscribeRequests).toHaveLength(1);

        const secondConnection = nextServerSocket();
        serverSocket.destroy();
        await secondConnection;

        await vi.waitFor(() => expect(subscribeRequests).toHaveLength(2), { timeout: 2000 });
        expect(subscribeRequests[1]?.symbolId).toEqual([1]);
    });

    it('fetches trendbars and converts the delta-encoded, scaled OHLC into clean decimals', async () => {
        const requests: ProtoOAGetTrendbarsReq[] = [];
        const { client } = createTestClient(server, port, createdClients, {
            onOtherRequest: (request) => {
                if (request.payloadType === ProtoOAPayloadType.PROTO_OA_GET_TRENDBARS_REQ) {
                    requests.push(ProtoOAGetTrendbarsReq.decode(request.payload ?? new Uint8Array()));
                    return ProtoMessage.fromPartial({
                        payloadType: ProtoOAPayloadType.PROTO_OA_GET_TRENDBARS_RES,
                        payload: ProtoOAGetTrendbarsRes.encode(
                            ProtoOAGetTrendbarsRes.fromPartial({
                                period: ProtoOATrendbarPeriod.H1,
                                trendbar: [
                                    ProtoOATrendbar.fromPartial({
                                        volume: 42,
                                        period: ProtoOATrendbarPeriod.H1,
                                        low: 100_000, // 1.00000
                                        deltaOpen: 500, // open = 1.00500
                                        deltaHigh: 1_000, // high = 1.01000
                                        deltaClose: 200, // close = 1.00200
                                        utcTimestampInMinutes: 1_000
                                    })
                                ]
                            })
                        ).finish(),
                        clientMsgId: request.clientMsgId
                    });
                }
                return undefined;
            }
        });
        await client.connect();

        const marketData = new SpotwareMarketData(client);
        const bars = await marketData.getTrendbars({
            symbolId: 1,
            period: ProtoOATrendbarPeriod.H1,
            fromTimestamp: 1_000_000,
            toTimestamp: 2_000_000,
            count: 10
        });

        expect(requests[0]).toMatchObject({ symbolId: 1, period: ProtoOATrendbarPeriod.H1, fromTimestamp: 1_000_000, toTimestamp: 2_000_000, count: 10 });
        expect(bars).toEqual([
            {
                period: ProtoOATrendbarPeriod.H1,
                timestamp: 1_000 * 60_000,
                low: 1.0,
                open: 1.005,
                high: 1.01,
                close: 1.002,
                volume: 42
            }
        ]);
    });

    it('writes period on the wire even when it is M1 (the implicit proto2 default)', async () => {
        const rawPayloads: Uint8Array[] = [];
        const { client } = createTestClient(server, port, createdClients, {
            onOtherRequest: (request) => {
                if (request.payloadType === ProtoOAPayloadType.PROTO_OA_GET_TRENDBARS_REQ) {
                    rawPayloads.push(request.payload ?? new Uint8Array());
                    return ProtoMessage.fromPartial({
                        payloadType: ProtoOAPayloadType.PROTO_OA_GET_TRENDBARS_RES,
                        payload: ProtoOAGetTrendbarsRes.encode(ProtoOAGetTrendbarsRes.fromPartial({})).finish(),
                        clientMsgId: request.clientMsgId
                    });
                }
                return undefined;
            }
        });
        await client.connect();

        const marketData = new SpotwareMarketData(client);
        await marketData.getTrendbars({ symbolId: 1, period: ProtoOATrendbarPeriod.M1 });

        expect(rawPayloads).toHaveLength(1);
        // field 5 (period), varint wire type -> tag 0x28, value M1=1
        expect(containsByteSequence(rawPayloads[0]!, [0x28, ProtoOATrendbarPeriod.M1])).toBe(true);
    });
});
