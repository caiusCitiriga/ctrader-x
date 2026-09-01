import * as net from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SpotwareClient } from '../../src/client';
import {
    MAX_CASH_FLOW_RANGE_MS,
    SpotwareHistory,
} from '../../src/history/spotware-history';
import {
    ProtoMessage,
    ProtoOADealListByPositionIdReq,
    ProtoOADealListByPositionIdRes,
    ProtoOADealListReq,
    ProtoOADealListRes,
    ProtoOAOrderListRes,
    ProtoOAPayloadType,
} from '../../src/types';
import { createTestClient } from '../shared/create-test-client';
import { TEST_ACCOUNT_ID } from '../shared/fake-spotware-server';

describe('SpotwareHistory', () => {
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
        await Promise.all(createdClients.map((client) => client.disconnect()));
        await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    it('passes the requested range through and surfaces the server’s hasMore flag', async () => {
        let sent: ProtoOADealListReq | undefined;

        const { client } = createTestClient(server, port, createdClients, {
            onOtherRequest: (request) => {
                if (
                    request.payloadType !==
                    ProtoOAPayloadType.PROTO_OA_DEAL_LIST_REQ
                ) {
                    return undefined;
                }

                sent = ProtoOADealListReq.decode(
                    request.payload ?? new Uint8Array(),
                );

                return ProtoMessage.fromPartial({
                    payloadType: ProtoOAPayloadType.PROTO_OA_DEAL_LIST_RES,
                    payload: ProtoOADealListRes.encode(
                        ProtoOADealListRes.fromPartial({
                            ctidTraderAccountId: TEST_ACCOUNT_ID,
                            deal: [
                                {
                                    dealId: 1,
                                    orderId: 2,
                                    positionId: 3,
                                    volume: 100,
                                    filledVolume: 100,
                                    symbolId: 1,
                                },
                            ],
                            hasMore: true,
                        }),
                    ).finish(),
                    clientMsgId: request.clientMsgId,
                });
            },
        });
        await client.connect();
        const history = new SpotwareHistory(client);

        const page = await history.getDeals({
            fromTimestamp: 1_000,
            toTimestamp: 2_000,
            maxRows: 50,
        });

        expect(sent?.fromTimestamp).toBe(1_000);
        expect(sent?.toTimestamp).toBe(2_000);
        expect(sent?.maxRows).toBe(50);
        // hasMore is the caller's only signal that the range needs narrowing, so it must not be
        // swallowed by the convenience wrapper.
        expect(page.hasMore).toBe(true);
        expect(page.deals).toHaveLength(1);
    });

    it('scopes a deal query to one position', async () => {
        let sent: ProtoOADealListByPositionIdReq | undefined;

        const { client } = createTestClient(server, port, createdClients, {
            onOtherRequest: (request) => {
                if (
                    request.payloadType !==
                    ProtoOAPayloadType.PROTO_OA_DEAL_LIST_BY_POSITION_ID_REQ
                ) {
                    return undefined;
                }

                sent = ProtoOADealListByPositionIdReq.decode(
                    request.payload ?? new Uint8Array(),
                );

                return ProtoMessage.fromPartial({
                    payloadType:
                        ProtoOAPayloadType.PROTO_OA_DEAL_LIST_BY_POSITION_ID_RES,
                    payload: ProtoOADealListByPositionIdRes.encode(
                        ProtoOADealListByPositionIdRes.fromPartial({
                            ctidTraderAccountId: TEST_ACCOUNT_ID,
                            deal: [],
                            hasMore: false,
                        }),
                    ).finish(),
                    clientMsgId: request.clientMsgId,
                });
            },
        });
        await client.connect();
        const history = new SpotwareHistory(client);

        await history.getDealsByPositionId({ positionId: 4_242 });

        expect(sent?.positionId).toBe(4_242);
    });

    it('returns orders with their paging flag', async () => {
        const { client } = createTestClient(server, port, createdClients, {
            onOtherRequest: (request) =>
                request.payloadType ===
                ProtoOAPayloadType.PROTO_OA_ORDER_LIST_REQ
                    ? ProtoMessage.fromPartial({
                          payloadType:
                              ProtoOAPayloadType.PROTO_OA_ORDER_LIST_RES,
                          payload: ProtoOAOrderListRes.encode(
                              ProtoOAOrderListRes.fromPartial({
                                  ctidTraderAccountId: TEST_ACCOUNT_ID,
                                  order: [],
                                  hasMore: false,
                              }),
                          ).finish(),
                          clientMsgId: request.clientMsgId,
                      })
                    : undefined,
        });
        await client.connect();
        const history = new SpotwareHistory(client);

        expect(
            await history.getOrders({ fromTimestamp: 0, toTimestamp: 1_000 }),
        ).toEqual({ orders: [], hasMore: false });
    });

    it('rejects a cash flow range wider than a week before sending anything', async () => {
        let requestsSent = 0;

        const { client } = createTestClient(server, port, createdClients, {
            onOtherRequest: (request) => {
                if (
                    request.payloadType ===
                    ProtoOAPayloadType.PROTO_OA_CASH_FLOW_HISTORY_LIST_REQ
                ) {
                    requestsSent += 1;
                }
                return undefined;
            },
        });
        await client.connect();
        const history = new SpotwareHistory(client);

        // Failing locally beats waiting out a request timeout for a server error the caller
        // would then have to interpret.
        await expect(
            history.getCashFlow({
                fromTimestamp: 0,
                toTimestamp: MAX_CASH_FLOW_RANGE_MS + 1,
            }),
        ).rejects.toThrow(RangeError);
        expect(requestsSent).toBe(0);
    });

    it('accepts a range of exactly one week', async () => {
        const { client } = createTestClient(server, port, createdClients, {
            onOtherRequest: (request) =>
                request.payloadType ===
                ProtoOAPayloadType.PROTO_OA_CASH_FLOW_HISTORY_LIST_REQ
                    ? ProtoMessage.fromPartial({
                          payloadType:
                              ProtoOAPayloadType.PROTO_OA_CASH_FLOW_HISTORY_LIST_RES,
                          payload: new Uint8Array(),
                          clientMsgId: request.clientMsgId,
                      })
                    : undefined,
        });
        await client.connect();
        const history = new SpotwareHistory(client);

        await expect(
            history.getCashFlow({
                fromTimestamp: 0,
                toTimestamp: MAX_CASH_FLOW_RANGE_MS,
            }),
        ).resolves.toEqual([]);
    });
});
