import * as net from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SpotwareClient } from '../../src/client';
import { SpotwareTrading } from '../../src/trading/spotware-trading';
import {
    ProtoMessage,
    ProtoOAAmendOrderReq,
    ProtoOAAmendPositionSLTPReq,
    ProtoOACancelOrderReq,
    ProtoOAClosePositionReq,
    ProtoOAExecutionEvent,
    ProtoOAExecutionType,
    ProtoOANewOrderReq,
    ProtoOAOrder,
    ProtoOAOrderErrorEvent,
    ProtoOAOrderType,
    ProtoOAPayloadType,
    ProtoOAPosition,
    ProtoOAReconcileReq,
    ProtoOAReconcileRes,
    ProtoOATradeSide
} from '../../src/types';
import { encodeFrame } from '../../src/transport/frame-codec';
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

function executionEventResponse(clientMsgId: string | undefined, executionType = ProtoOAExecutionType.ORDER_ACCEPTED): ProtoMessage {
    return ProtoMessage.fromPartial({
        payloadType: ProtoOAPayloadType.PROTO_OA_EXECUTION_EVENT,
        payload: ProtoOAExecutionEvent.encode(
            ProtoOAExecutionEvent.fromPartial({
                ctidTraderAccountId: TEST_ACCOUNT_ID,
                executionType
            })
        ).finish(),
        clientMsgId
    });
}

function orderErrorResponse(clientMsgId: string | undefined, errorCode: string): ProtoMessage {
    return ProtoMessage.fromPartial({
        payloadType: ProtoOAPayloadType.PROTO_OA_ORDER_ERROR_EVENT,
        payload: ProtoOAOrderErrorEvent.encode(
            ProtoOAOrderErrorEvent.fromPartial({
                ctidTraderAccountId: TEST_ACCOUNT_ID,
                errorCode
            })
        ).finish(),
        clientMsgId
    });
}

describe('SpotwareTrading', () => {
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

    it('places a market order with the volume scaled and no price fields set', async () => {
        const requests: ProtoOANewOrderReq[] = [];
        const { client } = createTestClient(server, port, createdClients, {
            onOtherRequest: (request) => {
                if (request.payloadType === ProtoOAPayloadType.PROTO_OA_NEW_ORDER_REQ) {
                    requests.push(ProtoOANewOrderReq.decode(request.payload ?? new Uint8Array()));
                    return executionEventResponse(request.clientMsgId, ProtoOAExecutionType.ORDER_FILLED);
                }
                return undefined;
            }
        });
        await client.connect();

        const trading = new SpotwareTrading(client);
        const result = await trading.placeMarketOrder({
            symbolId: 1,
            tradeSide: ProtoOATradeSide.BUY,
            volume: 1_000
        });

        expect(requests).toHaveLength(1);
        expect(requests[0]?.orderType).toBe(ProtoOAOrderType.MARKET);
        expect(requests[0]?.volume).toBe(100_000); // 1000 units * SPOTWARE_VOLUME_SCALE
        // ts-proto decodes an unset optional number field to its zero value, not undefined.
        expect(requests[0]?.limitPrice).toBe(0);
        expect(result.executionType).toBe(ProtoOAExecutionType.ORDER_FILLED);
    });

    it('writes orderType and tradeSide on the wire even when they are MARKET/BUY (the implicit proto2 default)', async () => {
        const rawPayloads: Uint8Array[] = [];
        const { client } = createTestClient(server, port, createdClients, {
            onOtherRequest: (request) => {
                if (request.payloadType === ProtoOAPayloadType.PROTO_OA_NEW_ORDER_REQ) {
                    rawPayloads.push(request.payload ?? new Uint8Array());
                    return executionEventResponse(request.clientMsgId);
                }
                return undefined;
            }
        });
        await client.connect();

        const trading = new SpotwareTrading(client);
        await trading.placeMarketOrder({
            symbolId: 1,
            tradeSide: ProtoOATradeSide.BUY,
            volume: 1_000
        });

        expect(rawPayloads).toHaveLength(1);
        // field 4 (orderType), varint wire type -> tag 0x20, value MARKET=1
        expect(containsByteSequence(rawPayloads[0]!, [0x20, ProtoOAOrderType.MARKET])).toBe(true);
        // field 5 (tradeSide), varint wire type -> tag 0x28, value BUY=1
        expect(containsByteSequence(rawPayloads[0]!, [0x28, ProtoOATradeSide.BUY])).toBe(true);
    });

    it('places a limit order with an unscaled absolute limitPrice', async () => {
        const requests: ProtoOANewOrderReq[] = [];
        const { client } = createTestClient(server, port, createdClients, {
            onOtherRequest: (request) => {
                if (request.payloadType === ProtoOAPayloadType.PROTO_OA_NEW_ORDER_REQ) {
                    requests.push(ProtoOANewOrderReq.decode(request.payload ?? new Uint8Array()));
                    return executionEventResponse(request.clientMsgId, ProtoOAExecutionType.ORDER_ACCEPTED);
                }
                return undefined;
            }
        });
        await client.connect();

        const trading = new SpotwareTrading(client);
        await trading.placeLimitOrder({
            symbolId: 1,
            tradeSide: ProtoOATradeSide.SELL,
            volume: 500,
            limitPrice: 1.2345,
            stopLoss: 1.24,
            takeProfit: 1.2
        });

        expect(requests[0]?.orderType).toBe(ProtoOAOrderType.LIMIT);
        expect(requests[0]?.volume).toBe(50_000);
        // Absolute prices are NOT divided by SPOTWARE_PRICE_SCALE, unlike bid/ask.
        expect(requests[0]?.limitPrice).toBe(1.2345);
        expect(requests[0]?.stopLoss).toBe(1.24);
        expect(requests[0]?.takeProfit).toBe(1.2);
    });

    it('rejects order placement with a typed error on PROTO_OA_ORDER_ERROR_EVENT', async () => {
        const { client } = createTestClient(server, port, createdClients, {
            onOtherRequest: (request) => {
                if (request.payloadType === ProtoOAPayloadType.PROTO_OA_NEW_ORDER_REQ) {
                    return orderErrorResponse(request.clientMsgId, 'NOT_ENOUGH_MONEY');
                }
                return undefined;
            }
        });
        await client.connect();

        const trading = new SpotwareTrading(client);

        await expect(
            trading.placeMarketOrder({
                symbolId: 1,
                tradeSide: ProtoOATradeSide.BUY,
                volume: 1_000_000
            })
        ).rejects.toMatchObject({
            errorCode: 'NOT_ENOUGH_MONEY'
        });
    });

    it('amends an order with the volume scaled', async () => {
        const requests: ProtoOAAmendOrderReq[] = [];
        const { client } = createTestClient(server, port, createdClients, {
            onOtherRequest: (request) => {
                if (request.payloadType === ProtoOAPayloadType.PROTO_OA_AMEND_ORDER_REQ) {
                    requests.push(ProtoOAAmendOrderReq.decode(request.payload ?? new Uint8Array()));
                    return executionEventResponse(request.clientMsgId, ProtoOAExecutionType.ORDER_REPLACED);
                }
                return undefined;
            }
        });
        await client.connect();

        const trading = new SpotwareTrading(client);
        const result = await trading.amendOrder({
            orderId: 42,
            volume: 200,
            limitPrice: 1.3
        });

        expect(requests[0]?.orderId).toBe(42);
        expect(requests[0]?.volume).toBe(20_000);
        expect(requests[0]?.limitPrice).toBe(1.3);
        expect(result.executionType).toBe(ProtoOAExecutionType.ORDER_REPLACED);
    });

    it('cancels an order', async () => {
        const requests: ProtoOACancelOrderReq[] = [];
        const { client } = createTestClient(server, port, createdClients, {
            onOtherRequest: (request) => {
                if (request.payloadType === ProtoOAPayloadType.PROTO_OA_CANCEL_ORDER_REQ) {
                    requests.push(ProtoOACancelOrderReq.decode(request.payload ?? new Uint8Array()));
                    return executionEventResponse(request.clientMsgId, ProtoOAExecutionType.ORDER_CANCELLED);
                }
                return undefined;
            }
        });
        await client.connect();

        const trading = new SpotwareTrading(client);
        const result = await trading.cancelOrder(7);

        expect(requests[0]?.orderId).toBe(7);
        expect(result.executionType).toBe(ProtoOAExecutionType.ORDER_CANCELLED);
    });

    it('closes a position with the volume scaled', async () => {
        const requests: ProtoOAClosePositionReq[] = [];
        const { client } = createTestClient(server, port, createdClients, {
            onOtherRequest: (request) => {
                if (request.payloadType === ProtoOAPayloadType.PROTO_OA_CLOSE_POSITION_REQ) {
                    requests.push(ProtoOAClosePositionReq.decode(request.payload ?? new Uint8Array()));
                    return executionEventResponse(request.clientMsgId, ProtoOAExecutionType.ORDER_FILLED);
                }
                return undefined;
            }
        });
        await client.connect();

        const trading = new SpotwareTrading(client);
        await trading.closePosition({ positionId: 99, volume: 300 });

        expect(requests[0]?.positionId).toBe(99);
        expect(requests[0]?.volume).toBe(30_000);
    });

    it('queries open positions and pending orders', async () => {
        const { client } = createTestClient(server, port, createdClients, {
            onOtherRequest: (request) => {
                if (request.payloadType === ProtoOAPayloadType.PROTO_OA_RECONCILE_REQ) {
                    return ProtoMessage.fromPartial({
                        payloadType: ProtoOAPayloadType.PROTO_OA_RECONCILE_RES,
                        payload: ProtoOAReconcileRes.encode(
                            ProtoOAReconcileRes.fromPartial({
                                ctidTraderAccountId: TEST_ACCOUNT_ID,
                                position: [
                                    ProtoOAPosition.fromPartial({
                                        positionId: 1
                                    })
                                ],
                                order: [ProtoOAOrder.fromPartial({ orderId: 2 })]
                            })
                        ).finish(),
                        clientMsgId: request.clientMsgId
                    });
                }
                return undefined;
            }
        });
        await client.connect();

        const trading = new SpotwareTrading(client);
        const { positions, orders } = await trading.getOpenPositionsAndOrders();

        expect(positions).toEqual([expect.objectContaining({ positionId: 1 })]);
        expect(orders).toEqual([expect.objectContaining({ orderId: 2 })]);
    });

    it.each([
        ['placeStopOrder', ProtoOAOrderType.STOP],
        ['placeStopLimitOrder', ProtoOAOrderType.STOP_LIMIT],
        ['placeMarketRangeOrder', ProtoOAOrderType.MARKET_RANGE]
    ] as const)('sends the right orderType for %s', async (method, expectedOrderType) => {
        const requests: ProtoOANewOrderReq[] = [];
        const { client } = createTestClient(server, port, createdClients, {
            onOtherRequest: (request) => {
                if (request.payloadType === ProtoOAPayloadType.PROTO_OA_NEW_ORDER_REQ) {
                    requests.push(ProtoOANewOrderReq.decode(request.payload ?? new Uint8Array()));
                    return executionEventResponse(request.clientMsgId);
                }
                return undefined;
            }
        });
        await client.connect();

        const trading = new SpotwareTrading(client);
        await trading[method]({
            symbolId: 1,
            tradeSide: ProtoOATradeSide.SELL,
            volume: 500,
            stopPrice: 1.2,
            baseSlippagePrice: 1.2,
            slippageInPoints: 10
        });

        expect(requests[0]?.orderType).toBe(expectedOrderType);
        expect(requests[0]?.volume).toBe(50_000);
    });

    it('carries the stop price and slippage of a stop-limit order', async () => {
        const requests: ProtoOANewOrderReq[] = [];
        const { client } = createTestClient(server, port, createdClients, {
            onOtherRequest: (request) => {
                if (request.payloadType === ProtoOAPayloadType.PROTO_OA_NEW_ORDER_REQ) {
                    requests.push(ProtoOANewOrderReq.decode(request.payload ?? new Uint8Array()));
                    return executionEventResponse(request.clientMsgId);
                }
                return undefined;
            }
        });
        await client.connect();

        const trading = new SpotwareTrading(client);
        await trading.placeStopLimitOrder({
            symbolId: 1,
            tradeSide: ProtoOATradeSide.BUY,
            volume: 100,
            stopPrice: 1.23456,
            slippageInPoints: 5
        });

        // Absolute order prices are plain decimals, not the 1/100000 fixed-point scale used for
        // spot quotes — sending a scaled value here would be off by five orders of magnitude.
        expect(requests[0]?.stopPrice).toBeCloseTo(1.23456, 5);
        expect(requests[0]?.slippageInPoints).toBe(5);
    });

    it('amends the stops on an open position rather than on an order', async () => {
        const requests: ProtoOAAmendPositionSLTPReq[] = [];
        const { client } = createTestClient(server, port, createdClients, {
            onOtherRequest: (request) => {
                if (request.payloadType === ProtoOAPayloadType.PROTO_OA_AMEND_POSITION_SLTP_REQ) {
                    requests.push(ProtoOAAmendPositionSLTPReq.decode(request.payload ?? new Uint8Array()));
                    return executionEventResponse(request.clientMsgId);
                }
                return undefined;
            }
        });
        await client.connect();

        const trading = new SpotwareTrading(client);
        await trading.amendPositionStopLossTakeProfit({
            positionId: 77,
            stopLoss: 1.1,
            trailingStopLoss: true
        });

        expect(requests).toHaveLength(1);
        expect(requests[0]?.positionId).toBe(77);
        expect(requests[0]?.stopLoss).toBeCloseTo(1.1, 5);
        expect(requests[0]?.trailingStopLoss).toBe(true);
    });

    it('emits an execution event that answers no request of its own', async () => {
        const harness = createTestClient(server, port, createdClients);
        const socketPromise = harness.nextServerSocket();
        await harness.client.connect();
        const socket = await socketPromise;

        const trading = new SpotwareTrading(harness.client);
        // The whole point of the event: a stop-loss firing hours later carries no clientMsgId,
        // so nothing is awaiting it and it would otherwise be invisible.
        const executed = new Promise<ProtoOAExecutionEvent>((resolve) => trading.on('execution', resolve));

        socket.write(encodeFrame(ProtoMessage.encode(executionEventResponse(undefined, ProtoOAExecutionType.ORDER_FILLED)).finish()));

        expect((await executed).executionType).toBe(ProtoOAExecutionType.ORDER_FILLED);
    });

    it('emits execution events for the caller’s own orders too', async () => {
        const { client } = createTestClient(server, port, createdClients, {
            onOtherRequest: (request) =>
                request.payloadType === ProtoOAPayloadType.PROTO_OA_NEW_ORDER_REQ
                    ? executionEventResponse(request.clientMsgId, ProtoOAExecutionType.ORDER_ACCEPTED)
                    : undefined
        });
        await client.connect();

        const trading = new SpotwareTrading(client);
        const seen: ProtoOAExecutionEvent[] = [];
        trading.on('execution', (event) => seen.push(event));

        await trading.placeMarketOrder({
            symbolId: 1,
            tradeSide: ProtoOATradeSide.BUY,
            volume: 100
        });

        // A listener should see the account's complete lifecycle, not just the parts nobody
        // happened to await.
        expect(seen.map((event) => event.executionType)).toEqual([ProtoOAExecutionType.ORDER_ACCEPTED]);
    });

    it('emits an order rejection that answers no request of its own', async () => {
        const harness = createTestClient(server, port, createdClients);
        const socketPromise = harness.nextServerSocket();
        await harness.client.connect();
        const socket = await socketPromise;

        const trading = new SpotwareTrading(harness.client);
        const rejected = new Promise<ProtoOAOrderErrorEvent>((resolve) => trading.on('orderError', resolve));

        socket.write(encodeFrame(ProtoMessage.encode(orderErrorResponse(undefined, 'POSITION_NOT_FOUND')).finish()));

        expect((await rejected).errorCode).toBe('POSITION_NOT_FOUND');
    });
});
