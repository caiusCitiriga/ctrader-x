import * as net from 'node:net';

import { encodeFrame, FrameDecoder } from '../../src/transport/frame-codec';
import {
    ProtoMessage,
    ProtoOAAccountAuthRes,
    ProtoOAApplicationAuthRes,
    ProtoOALightSymbol,
    ProtoOAPayloadType,
    ProtoOASubscribeDepthQuotesRes,
    ProtoOASubscribeLiveTrendbarRes,
    ProtoOASubscribeSpotsRes,
    ProtoOASymbolsListRes,
    ProtoOAUnsubscribeDepthQuotesRes,
    ProtoOAUnsubscribeLiveTrendbarRes,
    ProtoOAUnsubscribeSpotsRes,
} from '../../src/types';

export const TEST_ACCOUNT_ID = 777;
export const TEST_SYMBOLS: ProtoOALightSymbol[] = [
    ProtoOALightSymbol.fromPartial({ symbolId: 1, symbolName: 'EURUSD' }),
    ProtoOALightSymbol.fromPartial({ symbolId: 2, symbolName: 'GBPUSD' }),
];

// Answers the auth handshake plus symbols/subscribe/unsubscribe the way a real server would.
// onOtherRequest sees every request first (useful for assertions) and can optionally override
// the default response by returning one instead of undefined.
export function wireFakeServer(
    socket: net.Socket,
    options: {
        symbols?: ProtoOALightSymbol[];
        onOtherRequest?: (request: ProtoMessage) => ProtoMessage | undefined;
        // Return false to simulate a dropped/unanswered request, e.g. to test timeout/retry behavior.
        shouldRespond?: (request: ProtoMessage) => boolean;
    } = {},
): void {
    socket.resume();
    const decoder = new FrameDecoder();
    const symbols = options.symbols ?? TEST_SYMBOLS;

    socket.on('data', (chunk: Buffer) => {
        for (const frame of decoder.push(chunk)) {
            const request = ProtoMessage.decode(frame);
            if (options.shouldRespond && !options.shouldRespond(request)) {
                continue;
            }

            // onOtherRequest runs first so it can observe every request (e.g. to count them),
            // even ones buildResponse already answers by default; its return value only
            // overrides the default response when it's non-undefined.
            const response =
                options.onOtherRequest?.(request) ??
                buildResponse(request, symbols);
            if (response) {
                socket.write(
                    encodeFrame(ProtoMessage.encode(response).finish()),
                );
            }
        }
    });
}

function buildResponse(
    request: ProtoMessage,
    symbols: ProtoOALightSymbol[],
): ProtoMessage | undefined {
    switch (request.payloadType) {
        case ProtoOAPayloadType.PROTO_OA_APPLICATION_AUTH_REQ:
            return ProtoMessage.fromPartial({
                payloadType: ProtoOAPayloadType.PROTO_OA_APPLICATION_AUTH_RES,
                payload: ProtoOAApplicationAuthRes.encode(
                    ProtoOAApplicationAuthRes.fromPartial({}),
                ).finish(),
            });
        case ProtoOAPayloadType.PROTO_OA_ACCOUNT_AUTH_REQ:
            return ProtoMessage.fromPartial({
                payloadType: ProtoOAPayloadType.PROTO_OA_ACCOUNT_AUTH_RES,
                payload: ProtoOAAccountAuthRes.encode(
                    ProtoOAAccountAuthRes.fromPartial({
                        ctidTraderAccountId: TEST_ACCOUNT_ID,
                    }),
                ).finish(),
            });
        case ProtoOAPayloadType.PROTO_OA_SYMBOLS_LIST_REQ:
            return ProtoMessage.fromPartial({
                payloadType: ProtoOAPayloadType.PROTO_OA_SYMBOLS_LIST_RES,
                payload: ProtoOASymbolsListRes.encode(
                    ProtoOASymbolsListRes.fromPartial({
                        ctidTraderAccountId: TEST_ACCOUNT_ID,
                        symbol: symbols,
                    }),
                ).finish(),
                clientMsgId: request.clientMsgId,
            });
        case ProtoOAPayloadType.PROTO_OA_SUBSCRIBE_SPOTS_REQ:
            return ProtoMessage.fromPartial({
                payloadType: ProtoOAPayloadType.PROTO_OA_SUBSCRIBE_SPOTS_RES,
                payload: ProtoOASubscribeSpotsRes.encode(
                    ProtoOASubscribeSpotsRes.fromPartial({
                        ctidTraderAccountId: TEST_ACCOUNT_ID,
                    }),
                ).finish(),
                clientMsgId: request.clientMsgId,
            });
        case ProtoOAPayloadType.PROTO_OA_SUBSCRIBE_LIVE_TRENDBAR_REQ:
            return ProtoMessage.fromPartial({
                payloadType:
                    ProtoOAPayloadType.PROTO_OA_SUBSCRIBE_LIVE_TRENDBAR_RES,
                payload: ProtoOASubscribeLiveTrendbarRes.encode(
                    ProtoOASubscribeLiveTrendbarRes.fromPartial({
                        ctidTraderAccountId: TEST_ACCOUNT_ID,
                    }),
                ).finish(),
                clientMsgId: request.clientMsgId,
            });
        case ProtoOAPayloadType.PROTO_OA_UNSUBSCRIBE_LIVE_TRENDBAR_REQ:
            return ProtoMessage.fromPartial({
                payloadType:
                    ProtoOAPayloadType.PROTO_OA_UNSUBSCRIBE_LIVE_TRENDBAR_RES,
                payload: ProtoOAUnsubscribeLiveTrendbarRes.encode(
                    ProtoOAUnsubscribeLiveTrendbarRes.fromPartial({
                        ctidTraderAccountId: TEST_ACCOUNT_ID,
                    }),
                ).finish(),
                clientMsgId: request.clientMsgId,
            });
        case ProtoOAPayloadType.PROTO_OA_SUBSCRIBE_DEPTH_QUOTES_REQ:
            return ProtoMessage.fromPartial({
                payloadType:
                    ProtoOAPayloadType.PROTO_OA_SUBSCRIBE_DEPTH_QUOTES_RES,
                payload: ProtoOASubscribeDepthQuotesRes.encode(
                    ProtoOASubscribeDepthQuotesRes.fromPartial({
                        ctidTraderAccountId: TEST_ACCOUNT_ID,
                    }),
                ).finish(),
                clientMsgId: request.clientMsgId,
            });
        case ProtoOAPayloadType.PROTO_OA_UNSUBSCRIBE_DEPTH_QUOTES_REQ:
            return ProtoMessage.fromPartial({
                payloadType:
                    ProtoOAPayloadType.PROTO_OA_UNSUBSCRIBE_DEPTH_QUOTES_RES,
                payload: ProtoOAUnsubscribeDepthQuotesRes.encode(
                    ProtoOAUnsubscribeDepthQuotesRes.fromPartial({
                        ctidTraderAccountId: TEST_ACCOUNT_ID,
                    }),
                ).finish(),
                clientMsgId: request.clientMsgId,
            });
        case ProtoOAPayloadType.PROTO_OA_UNSUBSCRIBE_SPOTS_REQ:
            return ProtoMessage.fromPartial({
                payloadType: ProtoOAPayloadType.PROTO_OA_UNSUBSCRIBE_SPOTS_RES,
                payload: ProtoOAUnsubscribeSpotsRes.encode(
                    ProtoOAUnsubscribeSpotsRes.fromPartial({
                        ctidTraderAccountId: TEST_ACCOUNT_ID,
                    }),
                ).finish(),
                clientMsgId: request.clientMsgId,
            });
        default:
            return undefined;
    }
}
