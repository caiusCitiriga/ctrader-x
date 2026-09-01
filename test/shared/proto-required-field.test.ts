import * as net from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SpotwareClient } from '../../src/client';
import { SpotwareHistory } from '../../src/history/spotware-history';
import { SpotwareMarketData } from '../../src/market-data/spotware-market-data';
import {
    ProtoMessage,
    ProtoOACashFlowHistoryListRes,
    ProtoOAGetTickDataRes,
    ProtoOAPayloadType,
    ProtoOAQuoteType,
    ProtoOATrendbarPeriod,
} from '../../src/types';
import { createTestClient } from './create-test-client';
import { TEST_ACCOUNT_ID } from './fake-spotware-server';

// ts-proto's decode() defaults an absent required field back to the very value encode() dropped
// it at, so a round trip through ts-proto on both ends cannot see this bug at all. Only the raw
// bytes can — which is what a stricter real server checks, and what these tests assert on.
function containsByteSequence(haystack: Uint8Array, needle: number[]): boolean {
    for (let i = 0; i <= haystack.length - needle.length; i += 1) {
        if (needle.every((byte, offset) => haystack[i + offset] === byte)) {
            return true;
        }
    }
    return false;
}

function countByteSequence(haystack: Uint8Array, needle: number[]): number {
    let count = 0;
    for (let i = 0; i <= haystack.length - needle.length; i += 1) {
        if (needle.every((byte, offset) => haystack[i + offset] === byte)) {
            count += 1;
        }
    }
    return count;
}

const PERIOD_FIELD_3_TAG = 0x18;
const TYPE_FIELD_4_TAG = 0x20;
const FROM_TIMESTAMP_FIELD_3_TAG = 0x18;

/**
 * Every one of these fields is `required` in the .proto yet sits at its implicit proto2 default
 * — the first enum member, or zero — which is precisely when ts-proto omits it. Each was
 * verified to be dropped before the fix, and each is a value a caller would realistically pass:
 * M1 is the most common bar period, BID the more common tick side, and 0 the natural
 * "since the beginning" timestamp.
 */
describe('required proto2 fields at their implicit default', () => {
    let server: net.Server;
    let port: number;
    let createdClients: SpotwareClient[];
    let sentRequests: ProtoMessage[];

    beforeEach(async () => {
        server = net.createServer();
        await new Promise<void>((resolve) =>
            server.listen(0, '127.0.0.1', resolve),
        );
        port = (server.address() as net.AddressInfo).port;
        createdClients = [];
        sentRequests = [];
    });

    afterEach(async () => {
        await Promise.all(createdClients.map((client) => client.disconnect()));
        await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    function capture(
        respondWith?: (request: ProtoMessage) => ProtoMessage | undefined,
    ) {
        return (request: ProtoMessage): ProtoMessage | undefined => {
            sentRequests.push(request);
            return respondWith?.(request);
        };
    }

    function payloadOf(payloadType: number): Uint8Array {
        const request = sentRequests.find(
            (sent) => sent.payloadType === payloadType,
        );
        expect(
            request,
            `no request of payload type ${payloadType} was sent`,
        ).toBeDefined();
        return request?.payload ?? new Uint8Array();
    }

    it('keeps M1 on the wire when subscribing to live trendbars', async () => {
        const { client } = createTestClient(server, port, createdClients, {
            onOtherRequest: capture(),
        });
        await client.connect();
        const marketData = new SpotwareMarketData(client);

        await marketData.subscribeLiveTrendbars({
            symbolId: 1,
            period: ProtoOATrendbarPeriod.M1,
        });

        const payload = payloadOf(
            ProtoOAPayloadType.PROTO_OA_SUBSCRIBE_LIVE_TRENDBAR_REQ,
        );
        expect(
            containsByteSequence(payload, [
                PERIOD_FIELD_3_TAG,
                ProtoOATrendbarPeriod.M1,
            ]),
        ).toBe(true);
    });

    it('keeps M1 on the wire when unsubscribing from live trendbars', async () => {
        const { client } = createTestClient(server, port, createdClients, {
            onOtherRequest: capture(),
        });
        await client.connect();
        const marketData = new SpotwareMarketData(client);

        await marketData.unsubscribeLiveTrendbars({
            symbolId: 1,
            period: ProtoOATrendbarPeriod.M1,
        });

        const payload = payloadOf(
            ProtoOAPayloadType.PROTO_OA_UNSUBSCRIBE_LIVE_TRENDBAR_REQ,
        );
        expect(
            containsByteSequence(payload, [
                PERIOD_FIELD_3_TAG,
                ProtoOATrendbarPeriod.M1,
            ]),
        ).toBe(true);
    });

    it('writes a non-default period exactly once', async () => {
        const { client } = createTestClient(server, port, createdClients, {
            onOtherRequest: capture(),
        });
        await client.connect();
        const marketData = new SpotwareMarketData(client);

        await marketData.subscribeLiveTrendbars({
            symbolId: 1,
            period: ProtoOATrendbarPeriod.M5,
        });

        const payload = payloadOf(
            ProtoOAPayloadType.PROTO_OA_SUBSCRIBE_LIVE_TRENDBAR_REQ,
        );
        expect(
            countByteSequence(payload, [
                PERIOD_FIELD_3_TAG,
                ProtoOATrendbarPeriod.M5,
            ]),
        ).toBe(1);
    });

    it('keeps BID on the wire when requesting tick data', async () => {
        const { client } = createTestClient(server, port, createdClients, {
            onOtherRequest: capture((request) =>
                request.payloadType ===
                ProtoOAPayloadType.PROTO_OA_GET_TICKDATA_REQ
                    ? ProtoMessage.fromPartial({
                          payloadType:
                              ProtoOAPayloadType.PROTO_OA_GET_TICKDATA_RES,
                          payload: ProtoOAGetTickDataRes.encode(
                              ProtoOAGetTickDataRes.fromPartial({
                                  ctidTraderAccountId: TEST_ACCOUNT_ID,
                                  tickData: [],
                                  hasMore: false,
                              }),
                          ).finish(),
                          clientMsgId: request.clientMsgId,
                      })
                    : undefined,
            ),
        });
        await client.connect();
        const marketData = new SpotwareMarketData(client);

        await marketData.getTickData({
            symbolId: 1,
            type: ProtoOAQuoteType.BID,
        });

        const payload = payloadOf(ProtoOAPayloadType.PROTO_OA_GET_TICKDATA_REQ);
        expect(
            containsByteSequence(payload, [
                TYPE_FIELD_4_TAG,
                ProtoOAQuoteType.BID,
            ]),
        ).toBe(true);
    });

    it('keeps a zero fromTimestamp on the wire for cash flow history', async () => {
        const { client } = createTestClient(server, port, createdClients, {
            onOtherRequest: capture((request) =>
                request.payloadType ===
                ProtoOAPayloadType.PROTO_OA_CASH_FLOW_HISTORY_LIST_REQ
                    ? ProtoMessage.fromPartial({
                          payloadType:
                              ProtoOAPayloadType.PROTO_OA_CASH_FLOW_HISTORY_LIST_RES,
                          payload: ProtoOACashFlowHistoryListRes.encode(
                              ProtoOACashFlowHistoryListRes.fromPartial({
                                  ctidTraderAccountId: TEST_ACCOUNT_ID,
                                  depositWithdraw: [],
                              }),
                          ).finish(),
                          clientMsgId: request.clientMsgId,
                      })
                    : undefined,
            ),
        });
        await client.connect();
        const history = new SpotwareHistory(client);

        await history.getCashFlow({ fromTimestamp: 0, toTimestamp: 1_000 });

        const payload = payloadOf(
            ProtoOAPayloadType.PROTO_OA_CASH_FLOW_HISTORY_LIST_REQ,
        );
        expect(
            containsByteSequence(payload, [FROM_TIMESTAMP_FIELD_3_TAG, 0x00]),
        ).toBe(true);
    });
});
