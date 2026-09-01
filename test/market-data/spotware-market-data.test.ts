import * as net from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SpotwareClient } from '../../src/client';
import {
    SpotwareMarketData,
    type IDepthUpdate,
    type ISpotwarePriceUpdate,
    type ITrendbar,
} from '../../src/market-data/spotware-market-data';
import { encodeFrame } from '../../src/transport/frame-codec';
import {
    ProtoMessage,
    ProtoOADepthEvent,
    ProtoOAGetTickDataRes,
    ProtoOAGetTrendbarsReq,
    ProtoOAGetTrendbarsRes,
    ProtoOAPayloadType,
    ProtoOAQuoteType,
    ProtoOASpotEvent,
    ProtoOASubscribeDepthQuotesReq,
    ProtoOASubscribeLiveTrendbarReq,
    ProtoOASubscribeSpotsReq,
    ProtoOATrendbar,
    ProtoOATrendbarPeriod,
} from '../../src/types';
import { createTestClient } from '../shared/create-test-client';
import { TEST_ACCOUNT_ID } from '../shared/fake-spotware-server';

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
        await new Promise<void>((resolve) =>
            server.listen(0, '127.0.0.1', resolve),
        );
        port = (server.address() as net.AddressInfo).port;
        createdClients = [];
    });

    afterEach(async () => {
        await Promise.all(
            createdClients.map((client) =>
                client.disconnect().catch(() => undefined),
            ),
        );
        await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    it('subscribes by symbolId', async () => {
        const subscribeRequests: ProtoOASubscribeSpotsReq[] = [];
        const { client } = createTestClient(server, port, createdClients, {
            onOtherRequest: (request) => {
                if (
                    request.payloadType ===
                    ProtoOAPayloadType.PROTO_OA_SUBSCRIBE_SPOTS_REQ
                ) {
                    subscribeRequests.push(
                        ProtoOASubscribeSpotsReq.decode(
                            request.payload ?? new Uint8Array(),
                        ),
                    );
                }
                return undefined;
            },
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
                if (
                    request.payloadType ===
                    ProtoOAPayloadType.PROTO_OA_SUBSCRIBE_SPOTS_REQ
                ) {
                    subscribeRequests.push(
                        ProtoOASubscribeSpotsReq.decode(
                            request.payload ?? new Uint8Array(),
                        ),
                    );
                }
                return undefined;
            },
        });
        await client.connect();

        const marketData = new SpotwareMarketData(client);
        await marketData.subscribe('gbpusd');

        expect(subscribeRequests[0]?.symbolId).toEqual([2]);
        // proves it went through the same catalog a consumer could use directly
        expect(await marketData.symbols.findByName('GBPUSD')).toMatchObject({
            symbolId: 2,
        });
    });

    it('rejects subscribing to an unknown symbol name', async () => {
        const { client } = createTestClient(server, port, createdClients);
        await client.connect();

        const marketData = new SpotwareMarketData(client);

        await expect(marketData.subscribe('NOPE')).rejects.toThrow(
            /unknown symbol/i,
        );
    });

    it('emits "price" with decimal bid/ask for a spot event, and forwards nothing for unrelated messages', async () => {
        const { client, nextServerSocket } = createTestClient(
            server,
            port,
            createdClients,
        );
        const firstConnection = nextServerSocket();
        await client.connect();
        const serverSocket = await firstConnection;

        const marketData = new SpotwareMarketData(client);
        const priceUpdates: unknown[] = [];
        marketData.on('price', (update) => priceUpdates.push(update));

        const spotEvent = ProtoMessage.fromPartial({
            payloadType: ProtoOAPayloadType.PROTO_OA_SPOT_EVENT,
            payload: ProtoOASpotEvent.encode(
                ProtoOASpotEvent.fromPartial({
                    ctidTraderAccountId: 777,
                    symbolId: 1,
                    bid: 123_000,
                    ask: 123_050,
                    timestamp: 42,
                }),
            ).finish(),
        });
        serverSocket.write(
            encodeFrame(ProtoMessage.encode(spotEvent).finish()),
        );

        await vi.waitFor(() => expect(priceUpdates).toHaveLength(1));
        expect(priceUpdates[0]).toEqual({
            symbolId: 1,
            bid: 1.23,
            ask: 1.2305,
            timestamp: 42,
        });
    });

    it('unsubscribes and stops tracking the symbol for resubscription', async () => {
        const subscribeCount = { value: 0 };
        const { client, nextServerSocket } = createTestClient(
            server,
            port,
            createdClients,
            {
                onOtherRequest: (request) => {
                    if (
                        request.payloadType ===
                        ProtoOAPayloadType.PROTO_OA_SUBSCRIBE_SPOTS_REQ
                    ) {
                        subscribeCount.value += 1;
                    }
                    return undefined;
                },
            },
        );
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
        await vi.waitFor(() => expect(authenticated).toHaveBeenCalledTimes(2), {
            timeout: 2000,
        });

        expect(subscribeCount.value).toBe(1);
    });

    it('resubscribes to previously subscribed symbols after a reconnect', async () => {
        const subscribeRequests: ProtoOASubscribeSpotsReq[] = [];
        const { client, nextServerSocket } = createTestClient(
            server,
            port,
            createdClients,
            {
                onOtherRequest: (request) => {
                    if (
                        request.payloadType ===
                        ProtoOAPayloadType.PROTO_OA_SUBSCRIBE_SPOTS_REQ
                    ) {
                        subscribeRequests.push(
                            ProtoOASubscribeSpotsReq.decode(
                                request.payload ?? new Uint8Array(),
                            ),
                        );
                    }
                    return undefined;
                },
            },
        );
        const firstConnection = nextServerSocket();
        await client.connect();
        const serverSocket = await firstConnection;

        const marketData = new SpotwareMarketData(client);
        await marketData.subscribe(1);
        expect(subscribeRequests).toHaveLength(1);

        const secondConnection = nextServerSocket();
        serverSocket.destroy();
        await secondConnection;

        await vi.waitFor(() => expect(subscribeRequests).toHaveLength(2), {
            timeout: 2000,
        });
        expect(subscribeRequests[1]?.symbolId).toEqual([1]);
    });

    it('fetches trendbars and converts the delta-encoded, scaled OHLC into clean decimals', async () => {
        const requests: ProtoOAGetTrendbarsReq[] = [];
        const { client } = createTestClient(server, port, createdClients, {
            onOtherRequest: (request) => {
                if (
                    request.payloadType ===
                    ProtoOAPayloadType.PROTO_OA_GET_TRENDBARS_REQ
                ) {
                    requests.push(
                        ProtoOAGetTrendbarsReq.decode(
                            request.payload ?? new Uint8Array(),
                        ),
                    );
                    return ProtoMessage.fromPartial({
                        payloadType:
                            ProtoOAPayloadType.PROTO_OA_GET_TRENDBARS_RES,
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
                                        utcTimestampInMinutes: 1_000,
                                    }),
                                ],
                            }),
                        ).finish(),
                        clientMsgId: request.clientMsgId,
                    });
                }
                return undefined;
            },
        });
        await client.connect();

        const marketData = new SpotwareMarketData(client);
        const bars = await marketData.getTrendbars({
            symbolId: 1,
            period: ProtoOATrendbarPeriod.H1,
            fromTimestamp: 1_000_000,
            toTimestamp: 2_000_000,
            count: 10,
        });

        expect(requests[0]).toMatchObject({
            symbolId: 1,
            period: ProtoOATrendbarPeriod.H1,
            fromTimestamp: 1_000_000,
            toTimestamp: 2_000_000,
            count: 10,
        });
        expect(bars).toEqual([
            {
                period: ProtoOATrendbarPeriod.H1,
                timestamp: 1_000 * 60_000,
                low: 1.0,
                open: 1.005,
                high: 1.01,
                close: 1.002,
                volume: 42,
            },
        ]);
    });

    it('writes period on the wire even when it is M1 (the implicit proto2 default)', async () => {
        const rawPayloads: Uint8Array[] = [];
        const { client } = createTestClient(server, port, createdClients, {
            onOtherRequest: (request) => {
                if (
                    request.payloadType ===
                    ProtoOAPayloadType.PROTO_OA_GET_TRENDBARS_REQ
                ) {
                    rawPayloads.push(request.payload ?? new Uint8Array());
                    return ProtoMessage.fromPartial({
                        payloadType:
                            ProtoOAPayloadType.PROTO_OA_GET_TRENDBARS_RES,
                        payload: ProtoOAGetTrendbarsRes.encode(
                            ProtoOAGetTrendbarsRes.fromPartial({}),
                        ).finish(),
                        clientMsgId: request.clientMsgId,
                    });
                }
                return undefined;
            },
        });
        await client.connect();

        const marketData = new SpotwareMarketData(client);
        await marketData.getTrendbars({
            symbolId: 1,
            period: ProtoOATrendbarPeriod.M1,
        });

        expect(rawPayloads).toHaveLength(1);
        // field 5 (period), varint wire type -> tag 0x28, value M1=1
        expect(
            containsByteSequence(rawPayloads[0]!, [
                0x28,
                ProtoOATrendbarPeriod.M1,
            ]),
        ).toBe(true);
    });

    it('emits a live "trendbar" carried inside a spot event', async () => {
        const { client, nextServerSocket } = createTestClient(
            server,
            port,
            createdClients,
        );
        const firstConnection = nextServerSocket();
        await client.connect();
        const serverSocket = await firstConnection;

        const marketData = new SpotwareMarketData(client);
        const received: Array<[number, ITrendbar]> = [];
        marketData.on('trendbar', (symbolId, trendbar) =>
            received.push([symbolId, trendbar]),
        );

        // cTrader piggybacks live bars on spot events rather than giving them their own message
        // type, so a client only watching for a dedicated payload type would never see one.
        const spotEvent = ProtoMessage.fromPartial({
            payloadType: ProtoOAPayloadType.PROTO_OA_SPOT_EVENT,
            payload: ProtoOASpotEvent.encode(
                ProtoOASpotEvent.fromPartial({
                    ctidTraderAccountId: TEST_ACCOUNT_ID,
                    symbolId: 1,
                    bid: 123_000,
                    trendbar: [
                        ProtoOATrendbar.fromPartial({
                            period: ProtoOATrendbarPeriod.M1,
                            low: 120_000,
                            deltaOpen: 1_000,
                            deltaHigh: 4_000,
                            deltaClose: 2_500,
                            volume: 17,
                            utcTimestampInMinutes: 100,
                        }),
                    ],
                }),
            ).finish(),
        });
        serverSocket.write(
            encodeFrame(ProtoMessage.encode(spotEvent).finish()),
        );

        await vi.waitFor(() => expect(received).toHaveLength(1));
        expect(received[0]?.[0]).toBe(1);
        expect(received[0]?.[1]).toEqual({
            period: ProtoOATrendbarPeriod.M1,
            timestamp: 6_000_000,
            open: 1.21,
            high: 1.24,
            low: 1.2,
            close: 1.225,
            volume: 17,
        });
    });

    it('emits "depth" with decimal prices and the ids that left the book', async () => {
        const { client, nextServerSocket } = createTestClient(
            server,
            port,
            createdClients,
        );
        const firstConnection = nextServerSocket();
        await client.connect();
        const serverSocket = await firstConnection;

        const marketData = new SpotwareMarketData(client);
        const received: IDepthUpdate[] = [];
        marketData.on('depth', (update) => received.push(update));

        const depthEvent = ProtoMessage.fromPartial({
            payloadType: ProtoOAPayloadType.PROTO_OA_DEPTH_EVENT,
            payload: ProtoOADepthEvent.encode(
                ProtoOADepthEvent.fromPartial({
                    ctidTraderAccountId: TEST_ACCOUNT_ID,
                    symbolId: 1,
                    newQuotes: [{ id: 10, size: 500_000, bid: 123_000 }],
                    deletedQuotes: [9],
                }),
            ).finish(),
        });
        serverSocket.write(
            encodeFrame(ProtoMessage.encode(depthEvent).finish()),
        );

        await vi.waitFor(() => expect(received).toHaveLength(1));
        expect(received[0]).toEqual({
            symbolId: 1,
            newQuotes: [{ id: 10, size: 500_000, bid: 1.23, ask: undefined }],
            deletedQuoteIds: [9],
        });
    });

    it('accumulates the delta-encoded tick data into absolute timestamps and prices', async () => {
        const { client } = createTestClient(server, port, createdClients, {
            onOtherRequest: (request) =>
                request.payloadType ===
                ProtoOAPayloadType.PROTO_OA_GET_TICKDATA_REQ
                    ? ProtoMessage.fromPartial({
                          payloadType:
                              ProtoOAPayloadType.PROTO_OA_GET_TICKDATA_RES,
                          payload: ProtoOAGetTickDataRes.encode(
                              ProtoOAGetTickDataRes.fromPartial({
                                  ctidTraderAccountId: TEST_ACCOUNT_ID,
                                  // Only the first entry is absolute; the rest are deltas, and
                                  // because ticks arrive newest-first they walk backwards.
                                  tickData: [
                                      {
                                          timestamp: 1_700_000_000_000,
                                          tick: 123_000,
                                      },
                                      { timestamp: -1_000, tick: -50 },
                                      { timestamp: -2_000, tick: 20 },
                                  ],
                                  hasMore: true,
                              }),
                          ).finish(),
                          clientMsgId: request.clientMsgId,
                      })
                    : undefined,
        });
        await client.connect();
        const marketData = new SpotwareMarketData(client);

        const page = await marketData.getTickData({
            symbolId: 1,
            type: ProtoOAQuoteType.BID,
        });

        expect(page.hasMore).toBe(true);
        expect(page.ticks).toEqual([
            { timestamp: 1_700_000_000_000, price: 1.23 },
            { timestamp: 1_699_999_999_000, price: 1.2295 },
            { timestamp: 1_699_999_997_000, price: 1.2297 },
        ]);
    });

    it('resubscribes to live trendbars and depth after a reconnect', async () => {
        const trendbarRequests: ProtoOASubscribeLiveTrendbarReq[] = [];
        const depthRequests: ProtoOASubscribeDepthQuotesReq[] = [];
        const { client, nextServerSocket } = createTestClient(
            server,
            port,
            createdClients,
            {
                onOtherRequest: (request) => {
                    if (
                        request.payloadType ===
                        ProtoOAPayloadType.PROTO_OA_SUBSCRIBE_LIVE_TRENDBAR_REQ
                    ) {
                        trendbarRequests.push(
                            ProtoOASubscribeLiveTrendbarReq.decode(
                                request.payload ?? new Uint8Array(),
                            ),
                        );
                    }
                    if (
                        request.payloadType ===
                        ProtoOAPayloadType.PROTO_OA_SUBSCRIBE_DEPTH_QUOTES_REQ
                    ) {
                        depthRequests.push(
                            ProtoOASubscribeDepthQuotesReq.decode(
                                request.payload ?? new Uint8Array(),
                            ),
                        );
                    }
                    return undefined;
                },
            },
        );
        const firstConnection = nextServerSocket();
        await client.connect();
        const serverSocket = await firstConnection;

        const marketData = new SpotwareMarketData(client);
        await marketData.subscribeLiveTrendbars({
            symbolId: 1,
            period: ProtoOATrendbarPeriod.M5,
        });
        await marketData.subscribeDepth(2);
        expect(trendbarRequests).toHaveLength(1);
        expect(depthRequests).toHaveLength(1);

        const secondConnection = nextServerSocket();
        serverSocket.destroy();
        await secondConnection;

        // A fresh TCP connection has no memory of any subscription, so every stream the caller
        // asked for has to be re-established, not just spots.
        await vi.waitFor(() => expect(trendbarRequests).toHaveLength(2), {
            timeout: 2000,
        });
        await vi.waitFor(() => expect(depthRequests).toHaveLength(2), {
            timeout: 2000,
        });
        expect(trendbarRequests[1]?.period).toBe(ProtoOATrendbarPeriod.M5);
        expect(trendbarRequests[1]?.symbolId).toBe(1);
        expect(depthRequests[1]?.symbolId).toEqual([2]);
    });

    it('stops resubscribing to a live trendbar once it is unsubscribed', async () => {
        const trendbarRequests: ProtoOASubscribeLiveTrendbarReq[] = [];
        const spotRequests: ProtoOASubscribeSpotsReq[] = [];
        const { client, nextServerSocket } = createTestClient(
            server,
            port,
            createdClients,
            {
                onOtherRequest: (request) => {
                    if (
                        request.payloadType ===
                        ProtoOAPayloadType.PROTO_OA_SUBSCRIBE_LIVE_TRENDBAR_REQ
                    ) {
                        trendbarRequests.push(
                            ProtoOASubscribeLiveTrendbarReq.decode(
                                request.payload ?? new Uint8Array(),
                            ),
                        );
                    }
                    if (
                        request.payloadType ===
                        ProtoOAPayloadType.PROTO_OA_SUBSCRIBE_SPOTS_REQ
                    ) {
                        spotRequests.push(
                            ProtoOASubscribeSpotsReq.decode(
                                request.payload ?? new Uint8Array(),
                            ),
                        );
                    }
                    return undefined;
                },
            },
        );
        const firstConnection = nextServerSocket();
        await client.connect();
        const serverSocket = await firstConnection;

        const marketData = new SpotwareMarketData(client);
        await marketData.subscribeLiveTrendbars({
            symbolId: 1,
            period: ProtoOATrendbarPeriod.M5,
        });
        await marketData.unsubscribeLiveTrendbars({
            symbolId: 1,
            period: ProtoOATrendbarPeriod.M5,
        });
        expect(spotRequests).toHaveLength(1);

        const secondConnection = nextServerSocket();
        serverSocket.destroy();
        await secondConnection;

        // The spot subscription that subscribeLiveTrendbars added on our behalf outlives the
        // trendbar one, so its resubscribe is the signal that the whole resubscribe pass has
        // run — without waiting for it, this would assert before there was anything to see.
        await vi.waitFor(() => expect(spotRequests).toHaveLength(2), {
            timeout: 2000,
        });
        expect(trendbarRequests).toHaveLength(1);
    });

    it('subscribes to spots automatically when subscribing to live trendbars', async () => {
        const spotRequests: ProtoOASubscribeSpotsReq[] = [];
        const { client } = createTestClient(server, port, createdClients, {
            onOtherRequest: (request) => {
                if (
                    request.payloadType ===
                    ProtoOAPayloadType.PROTO_OA_SUBSCRIBE_SPOTS_REQ
                ) {
                    spotRequests.push(
                        ProtoOASubscribeSpotsReq.decode(
                            request.payload ?? new Uint8Array(),
                        ),
                    );
                }
                return undefined;
            },
        });
        await client.connect();

        const marketData = new SpotwareMarketData(client);
        // Live bars ride on spot events, so a trendbar subscription without a spot subscription
        // silently produces nothing at all.
        await marketData.subscribeLiveTrendbars({
            symbolId: 1,
            period: ProtoOATrendbarPeriod.M5,
        });

        expect(spotRequests).toHaveLength(1);
        expect(spotRequests[0]?.symbolId).toEqual([1]);
    });

    it('reports an unchanged side as absent, not as a price of zero', async () => {
        const { client, nextServerSocket } = createTestClient(
            server,
            port,
            createdClients,
        );
        const firstConnection = nextServerSocket();
        await client.connect();
        const serverSocket = await firstConnection;

        const marketData = new SpotwareMarketData(client);
        const received: ISpotwarePriceUpdate[] = [];
        marketData.on('price', (update) => received.push(update));

        // cTrader omits the side that did not move, and ts-proto decodes the omission as 0 —
        // so reporting it verbatim would feed a plausible-looking 0.00 into a spread or mid.
        const spotEvent = ProtoMessage.fromPartial({
            payloadType: ProtoOAPayloadType.PROTO_OA_SPOT_EVENT,
            payload: ProtoOASpotEvent.encode(
                ProtoOASpotEvent.fromPartial({
                    ctidTraderAccountId: TEST_ACCOUNT_ID,
                    symbolId: 1,
                    bid: 123_000,
                }),
            ).finish(),
        });
        serverSocket.write(
            encodeFrame(ProtoMessage.encode(spotEvent).finish()),
        );

        await vi.waitFor(() => expect(received).toHaveLength(1));
        expect(received[0]?.bid).toBeCloseTo(1.23, 5);
        expect(received[0]?.ask).toBeUndefined();
    });
});
