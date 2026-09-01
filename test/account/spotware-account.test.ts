import * as net from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SpotwareAccount } from '../../src/account/spotware-account';
import { SpotwareClient } from '../../src/client';
import {
    ProtoMessage,
    ProtoOAAccountsTokenInvalidatedEvent,
    ProtoOAExpectedMarginReq,
    ProtoOAExpectedMarginRes,
    ProtoOAGetPositionUnrealizedPnLRes,
    ProtoOAMarginChangedEvent,
    ProtoOAPayloadType,
    ProtoOATrader,
    ProtoOATraderRes,
    ProtoOATraderUpdatedEvent,
} from '../../src/types';
import { createTestClient } from '../shared/create-test-client';
import { TEST_ACCOUNT_ID } from '../shared/fake-spotware-server';

function traderResponse(
    clientMsgId: string | undefined,
    trader: Partial<ProtoOATrader>,
): ProtoMessage {
    return ProtoMessage.fromPartial({
        payloadType: ProtoOAPayloadType.PROTO_OA_TRADER_RES,
        payload: ProtoOATraderRes.encode(
            ProtoOATraderRes.fromPartial({
                ctidTraderAccountId: TEST_ACCOUNT_ID,
                trader: ProtoOATrader.fromPartial({
                    ctidTraderAccountId: TEST_ACCOUNT_ID,
                    depositAssetId: 1,
                    ...trader,
                }),
            }),
        ).finish(),
        clientMsgId,
    });
}

function unsolicited(payloadType: number, payload: Uint8Array): ProtoMessage {
    return ProtoMessage.fromPartial({ payloadType, payload });
}

describe('SpotwareAccount', () => {
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

    it('converts the balance using the exponent from that same response', async () => {
        const { client } = createTestClient(server, port, createdClients, {
            onOtherRequest: (request) =>
                request.payloadType === ProtoOAPayloadType.PROTO_OA_TRADER_REQ
                    ? traderResponse(request.clientMsgId, {
                          balance: 10_053_099_944,
                          moneyDigits: 8,
                      })
                    : undefined,
        });
        await client.connect();
        const account = new SpotwareAccount(client);

        expect(await account.getBalance()).toBeCloseTo(100.53099944, 8);
    });

    it('falls back to hundredths for an account that reports no exponent', async () => {
        const { client } = createTestClient(server, port, createdClients, {
            onOtherRequest: (request) =>
                request.payloadType === ProtoOAPayloadType.PROTO_OA_TRADER_REQ
                    ? traderResponse(request.clientMsgId, { balance: 250_000 })
                    : undefined,
        });
        await client.connect();
        const account = new SpotwareAccount(client);

        expect(await account.getBalance()).toBeCloseTo(2_500, 2);
    });

    it('rejects rather than returning an account-less trader response', async () => {
        const { client } = createTestClient(server, port, createdClients, {
            onOtherRequest: (request) =>
                request.payloadType === ProtoOAPayloadType.PROTO_OA_TRADER_REQ
                    ? ProtoMessage.fromPartial({
                          payloadType: ProtoOAPayloadType.PROTO_OA_TRADER_RES,
                          payload: ProtoOATraderRes.encode(
                              ProtoOATraderRes.fromPartial({
                                  ctidTraderAccountId: TEST_ACCOUNT_ID,
                              }),
                          ).finish(),
                          clientMsgId: request.clientMsgId,
                      })
                    : undefined,
        });
        await client.connect();
        const account = new SpotwareAccount(client);

        await expect(account.getTrader()).rejects.toThrow(/no account details/);
    });

    it('sends volumes in cents and converts the margins back', async () => {
        let sentVolumes: number[] = [];

        const { client } = createTestClient(server, port, createdClients, {
            onOtherRequest: (request) => {
                if (
                    request.payloadType !==
                    ProtoOAPayloadType.PROTO_OA_EXPECTED_MARGIN_REQ
                ) {
                    return undefined;
                }

                sentVolumes = ProtoOAExpectedMarginReq.decode(
                    request.payload ?? new Uint8Array(),
                ).volume;

                return ProtoMessage.fromPartial({
                    payloadType:
                        ProtoOAPayloadType.PROTO_OA_EXPECTED_MARGIN_RES,
                    payload: ProtoOAExpectedMarginRes.encode(
                        ProtoOAExpectedMarginRes.fromPartial({
                            ctidTraderAccountId: TEST_ACCOUNT_ID,
                            moneyDigits: 2,
                            margin: [
                                {
                                    volume: 100_000,
                                    buyMargin: 33_150,
                                    sellMargin: 33_100,
                                },
                            ],
                        }),
                    ).finish(),
                    clientMsgId: request.clientMsgId,
                });
            },
        });
        await client.connect();
        const account = new SpotwareAccount(client);

        const margins = await account.getExpectedMargin({
            symbolId: 1,
            volumes: [1_000],
        });

        expect(sentVolumes).toEqual([100_000]);
        expect(margins).toEqual([
            { volume: 1_000, buyMargin: 331.5, sellMargin: 331 },
        ]);
    });

    it('converts unrealized PnL with the response exponent', async () => {
        const { client } = createTestClient(server, port, createdClients, {
            onOtherRequest: (request) =>
                request.payloadType ===
                ProtoOAPayloadType.PROTO_OA_GET_POSITION_UNREALIZED_PNL_REQ
                    ? ProtoMessage.fromPartial({
                          payloadType:
                              ProtoOAPayloadType.PROTO_OA_GET_POSITION_UNREALIZED_PNL_RES,
                          payload: ProtoOAGetPositionUnrealizedPnLRes.encode(
                              ProtoOAGetPositionUnrealizedPnLRes.fromPartial({
                                  ctidTraderAccountId: TEST_ACCOUNT_ID,
                                  moneyDigits: 2,
                                  positionUnrealizedPnL: [
                                      {
                                          positionId: 9,
                                          grossUnrealizedPnL: -1_250,
                                          netUnrealizedPnL: -1_310,
                                      },
                                  ],
                              }),
                          ).finish(),
                          clientMsgId: request.clientMsgId,
                      })
                    : undefined,
        });
        await client.connect();
        const account = new SpotwareAccount(client);

        expect(await account.getPositionsUnrealizedPnL()).toEqual([
            {
                positionId: 9,
                grossUnrealizedPnL: -12.5,
                netUnrealizedPnL: -13.1,
            },
        ]);
    });

    it('emits traderUpdated when the server pushes new account details', async () => {
        const harness = createTestClient(server, port, createdClients);
        const socketPromise = harness.nextServerSocket();
        await harness.client.connect();
        const socket = await socketPromise;

        const account = new SpotwareAccount(harness.client);
        const updated = new Promise<ProtoOATrader>((resolve) =>
            account.on('traderUpdated', resolve),
        );

        const { encodeFrame } = await import('../../src/transport/frame-codec');
        socket.write(
            encodeFrame(
                ProtoMessage.encode(
                    unsolicited(
                        ProtoOAPayloadType.PROTO_OA_TRADER_UPDATE_EVENT,
                        ProtoOATraderUpdatedEvent.encode(
                            ProtoOATraderUpdatedEvent.fromPartial({
                                ctidTraderAccountId: TEST_ACCOUNT_ID,
                                trader: ProtoOATrader.fromPartial({
                                    ctidTraderAccountId: TEST_ACCOUNT_ID,
                                    balance: 500_000,
                                    depositAssetId: 1,
                                }),
                            }),
                        ).finish(),
                    ),
                ).finish(),
            ),
        );

        expect((await updated).balance).toBe(500_000);
    });

    it('converts the amount on a margin change event', async () => {
        const harness = createTestClient(server, port, createdClients);
        const socketPromise = harness.nextServerSocket();
        await harness.client.connect();
        const socket = await socketPromise;

        const account = new SpotwareAccount(harness.client);
        const changed = new Promise<{ positionId: number; usedMargin: number }>(
            (resolve) => account.on('marginChanged', resolve),
        );

        const { encodeFrame } = await import('../../src/transport/frame-codec');
        socket.write(
            encodeFrame(
                ProtoMessage.encode(
                    unsolicited(
                        ProtoOAPayloadType.PROTO_OA_MARGIN_CHANGED_EVENT,
                        ProtoOAMarginChangedEvent.encode(
                            ProtoOAMarginChangedEvent.fromPartial({
                                ctidTraderAccountId: TEST_ACCOUNT_ID,
                                positionId: 42,
                                usedMargin: 33_150,
                                moneyDigits: 2,
                            }),
                        ).finish(),
                    ),
                ).finish(),
            ),
        );

        expect(await changed).toEqual({ positionId: 42, usedMargin: 331.5 });
    });

    it('reports a revoked token with the accounts it affects', async () => {
        const harness = createTestClient(server, port, createdClients);
        const socketPromise = harness.nextServerSocket();
        await harness.client.connect();
        const socket = await socketPromise;

        const account = new SpotwareAccount(harness.client);
        const invalidated = new Promise<[number[], string | undefined]>(
            (resolve) =>
                account.on('tokenInvalidated', (accountIds, reason) =>
                    resolve([accountIds, reason]),
                ),
        );

        const { encodeFrame } = await import('../../src/transport/frame-codec');
        socket.write(
            encodeFrame(
                ProtoMessage.encode(
                    unsolicited(
                        ProtoOAPayloadType.PROTO_OA_ACCOUNTS_TOKEN_INVALIDATED_EVENT,
                        ProtoOAAccountsTokenInvalidatedEvent.encode(
                            ProtoOAAccountsTokenInvalidatedEvent.fromPartial({
                                ctidTraderAccountIds: [TEST_ACCOUNT_ID],
                                reason: 'ACCESS_REVOKED',
                            }),
                        ).finish(),
                    ),
                ).finish(),
            ),
        );

        expect(await invalidated).toEqual([
            [TEST_ACCOUNT_ID],
            'ACCESS_REVOKED',
        ]);
    });
});
