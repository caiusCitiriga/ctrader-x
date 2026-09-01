import * as net from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SpotwareOAuthClient, type ISpotwareOAuthToken } from '../../src/auth';
import { SpotwareClient } from '../../src/client/spotware-client';
import { SpotwareRequestError } from '../../src/client/spotware-request-error';
import { encodeFrame, FrameDecoder } from '../../src/transport/frame-codec';
import {
    SpotwareHost,
    SpotwareTransport,
    type SpotwareSocketFactory,
} from '../../src/transport';
import {
    ProtoMessage,
    ProtoOAAccountAuthRes,
    ProtoOAApplicationAuthRes,
    ProtoOAErrorRes,
    ProtoOAOrderErrorEvent,
    ProtoOAPayloadType,
} from '../../src/types';

const TEST_ACCOUNT_ID = 555;
const GENERIC_REQUEST_PAYLOAD_TYPE = 9001;
const GENERIC_RESPONSE_PAYLOAD_TYPE = 9002;

function createLoopbackSocketFactory(port: number): SpotwareSocketFactory {
    return () =>
        new Promise((resolve, reject) => {
            const socket = net.connect(port, '127.0.0.1');
            socket.once('connect', () => resolve(socket));
            socket.once('error', reject);
        });
}

// Answers ApplicationAuthReq/AccountAuthReq the way a real server would, and forwards
// anything else to a custom handler so each test only deals with the requests it cares about.
function wireAutoAuthServer(
    socket: net.Socket,
    onOtherRequest?: (request: ProtoMessage) => ProtoMessage | undefined,
): void {
    socket.resume();
    const decoder = new FrameDecoder();

    socket.on('data', (chunk: Buffer) => {
        for (const frame of decoder.push(chunk)) {
            const request = ProtoMessage.decode(frame);
            let response: ProtoMessage | undefined;

            if (
                request.payloadType ===
                ProtoOAPayloadType.PROTO_OA_APPLICATION_AUTH_REQ
            ) {
                response = ProtoMessage.fromPartial({
                    payloadType:
                        ProtoOAPayloadType.PROTO_OA_APPLICATION_AUTH_RES,
                    payload: ProtoOAApplicationAuthRes.encode(
                        ProtoOAApplicationAuthRes.fromPartial({}),
                    ).finish(),
                });
            } else if (
                request.payloadType ===
                ProtoOAPayloadType.PROTO_OA_ACCOUNT_AUTH_REQ
            ) {
                response = ProtoMessage.fromPartial({
                    payloadType: ProtoOAPayloadType.PROTO_OA_ACCOUNT_AUTH_RES,
                    payload: ProtoOAAccountAuthRes.encode(
                        ProtoOAAccountAuthRes.fromPartial({
                            ctidTraderAccountId: TEST_ACCOUNT_ID,
                        }),
                    ).finish(),
                });
            } else {
                response = onOtherRequest?.(request);
            }

            if (response) {
                socket.write(
                    encodeFrame(ProtoMessage.encode(response).finish()),
                );
            }
        }
    });
}

interface ITestClientHarness {
    client: SpotwareClient;
    nextServerSocket(): Promise<net.Socket>;
}

function createTestClient(
    server: net.Server,
    port: number,
    oauthClient: SpotwareOAuthClient,
    createdClients: SpotwareClient[],
    options: {
        token?: ISpotwareOAuthToken;
        onOtherRequest?: (request: ProtoMessage) => ProtoMessage | undefined;
    } = {},
): ITestClientHarness {
    let pendingResolvers: Array<(socket: net.Socket) => void> = [];

    server.removeAllListeners('connection');
    server.on('connection', (socket) => {
        wireAutoAuthServer(socket, options.onOtherRequest);
        const resolvers = pendingResolvers;
        pendingResolvers = [];
        resolvers.forEach((resolve) => resolve(socket));
    });

    const transport = new SpotwareTransport({
        host: SpotwareHost.DEMO,
        port,
        socketFactory: createLoopbackSocketFactory(port),
        reconnectBackoff: { baseDelayMs: 10, maxDelayMs: 20, factor: 2 },
    });
    transport.on('error', () => undefined);

    const client = new SpotwareClient({
        transport,
        oauthClient,
        clientId: 'client-id',
        clientSecret: 'client-secret',
        ctidTraderAccountId: TEST_ACCOUNT_ID,
        token: options.token ?? {
            accessToken: 'access-token',
            refreshToken: 'refresh-token',
            tokenType: 'bearer',
            expiresIn: 2_628_000,
        },
        requestTimeoutMs: 200,
    });
    createdClients.push(client);

    return {
        client,
        nextServerSocket: () =>
            new Promise((resolve) => pendingResolvers.push(resolve)),
    };
}

describe('SpotwareClient', () => {
    let server: net.Server;
    let port: number;
    let oauthClient: SpotwareOAuthClient;
    let createdClients: SpotwareClient[];

    beforeEach(async () => {
        server = net.createServer();
        await new Promise<void>((resolve) =>
            server.listen(0, '127.0.0.1', resolve),
        );
        port = (server.address() as net.AddressInfo).port;
        oauthClient = new SpotwareOAuthClient({
            clientId: 'client-id',
            clientSecret: 'client-secret',
        });
        createdClients = [];
    });

    afterEach(async () => {
        // Disconnect regardless of whether the test itself passed, so a failed assertion
        // never leaves a connection open and turns into a confusing server.close() hang.
        await Promise.all(
            createdClients.map((client) =>
                client.disconnect().catch(() => undefined),
            ),
        );
        await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    it('authenticates on connect and forwards unsolicited messages', async () => {
        const { client, nextServerSocket } = createTestClient(
            server,
            port,
            oauthClient,
            createdClients,
        );
        const firstConnection = nextServerSocket();

        const authenticated = vi.fn();
        const messages: ProtoMessage[] = [];
        client.on('authenticated', authenticated);
        client.on('message', (message) => messages.push(message));

        await client.connect();
        expect(authenticated).toHaveBeenCalledOnce();

        const serverSocket = await firstConnection;
        const unsolicited = ProtoMessage.fromPartial({
            payloadType: 555,
            payload: new Uint8Array([9]),
        });
        serverSocket.write(
            encodeFrame(ProtoMessage.encode(unsolicited).finish()),
        );

        await vi.waitFor(() =>
            expect(
                messages.some((message) => message.payloadType === 555),
            ).toBe(true),
        );
    });

    it('correlates concurrent send() calls by clientMsgId even when responses arrive out of order', async () => {
        const requests: ProtoMessage[] = [];
        const { client, nextServerSocket } = createTestClient(
            server,
            port,
            oauthClient,
            createdClients,
            {
                // don't auto-respond; the test drives responses manually, out of order
                onOtherRequest: (request) => {
                    requests.push(request);
                    return undefined;
                },
            },
        );
        const firstConnection = nextServerSocket();

        await client.connect();
        const serverSocket = await firstConnection;

        const first = client.send(
            GENERIC_REQUEST_PAYLOAD_TYPE,
            new Uint8Array([1]),
        );
        const second = client.send(
            GENERIC_REQUEST_PAYLOAD_TYPE,
            new Uint8Array([2]),
        );

        await vi.waitFor(() => expect(requests).toHaveLength(2));

        const respondTo = (
            clientMsgId: string | undefined,
            payload: Uint8Array,
        ) =>
            serverSocket.write(
                encodeFrame(
                    ProtoMessage.encode(
                        ProtoMessage.fromPartial({
                            payloadType: GENERIC_RESPONSE_PAYLOAD_TYPE,
                            payload,
                            clientMsgId,
                        }),
                    ).finish(),
                ),
            );

        // second request's clientMsgId answered before the first's
        respondTo(requests[1]?.clientMsgId, new Uint8Array([20]));
        respondTo(requests[0]?.clientMsgId, new Uint8Array([10]));

        const [firstResponse, secondResponse] = await Promise.all([
            first,
            second,
        ]);
        expect(Array.from(firstResponse.payload ?? [])).toEqual([10]);
        expect(Array.from(secondResponse.payload ?? [])).toEqual([20]);
    });

    it('rejects send() with a typed error on a correlated PROTO_OA_ERROR_RES', async () => {
        const { client } = createTestClient(
            server,
            port,
            oauthClient,
            createdClients,
            {
                onOtherRequest: (request) =>
                    ProtoMessage.fromPartial({
                        payloadType: ProtoOAPayloadType.PROTO_OA_ERROR_RES,
                        payload: ProtoOAErrorRes.encode(
                            ProtoOAErrorRes.fromPartial({
                                errorCode: 'SYMBOL_NOT_FOUND',
                            }),
                        ).finish(),
                        clientMsgId: request.clientMsgId,
                    }),
            },
        );

        await client.connect();

        await expect(
            client.send(GENERIC_REQUEST_PAYLOAD_TYPE, new Uint8Array()),
        ).rejects.toMatchObject({ errorCode: 'SYMBOL_NOT_FOUND' });
    });

    it('rejects send() with a typed error on a correlated PROTO_OA_ORDER_ERROR_EVENT', async () => {
        // Order mutations (new/amend/cancel/close) have no dedicated _Res message — a rejected
        // order comes back as this event instead, and must not resolve as if it succeeded.
        const { client } = createTestClient(
            server,
            port,
            oauthClient,
            createdClients,
            {
                onOtherRequest: (request) =>
                    ProtoMessage.fromPartial({
                        payloadType:
                            ProtoOAPayloadType.PROTO_OA_ORDER_ERROR_EVENT,
                        payload: ProtoOAOrderErrorEvent.encode(
                            ProtoOAOrderErrorEvent.fromPartial({
                                ctidTraderAccountId: TEST_ACCOUNT_ID,
                                errorCode: 'NOT_ENOUGH_MONEY',
                            }),
                        ).finish(),
                        clientMsgId: request.clientMsgId,
                    }),
            },
        );

        await client.connect();

        await expect(
            client.send(GENERIC_REQUEST_PAYLOAD_TYPE, new Uint8Array()),
        ).rejects.toMatchObject({ errorCode: 'NOT_ENOUGH_MONEY' });
    });

    it('times out a send() call when no response ever arrives', async () => {
        const { client } = createTestClient(
            server,
            port,
            oauthClient,
            createdClients,
        );
        await client.connect();

        await expect(
            client.send(GENERIC_REQUEST_PAYLOAD_TYPE, new Uint8Array()),
        ).rejects.toBeInstanceOf(SpotwareRequestError);
    });

    it('forwards transport-level errors via its own "error" event', async () => {
        const { client, nextServerSocket } = createTestClient(
            server,
            port,
            oauthClient,
            createdClients,
        );
        const firstConnection = nextServerSocket();

        const error = vi.fn();
        client.on('error', error);

        await client.connect();
        const serverSocket = await firstConnection;

        // A corrupted length prefix trips the transport's frame-size guard, which is a
        // real transport-level 'error' — exactly the kind that used to have no listener.
        const corruptedLengthPrefix = Buffer.alloc(4);
        corruptedLengthPrefix.writeUInt32BE(64 * 1024 * 1024);
        serverSocket.write(corruptedLengthPrefix);

        await vi.waitFor(() => expect(error).toHaveBeenCalledOnce());
        expect(error.mock.calls[0]?.[0]).toBeInstanceOf(Error);
    });

    it('rejects in-flight send() calls immediately on disconnect, without waiting out their own timeout', async () => {
        let requestReceived: () => void;
        const requestReceivedPromise = new Promise<void>((resolve) => {
            requestReceived = resolve;
        });

        const { client } = createTestClient(
            server,
            port,
            oauthClient,
            createdClients,
            {
                // never respond, so the only way this settles is via disconnect or the (long) timeout
                onOtherRequest: () => {
                    requestReceived();
                    return undefined;
                },
            },
        );
        (client as unknown as { requestTimeoutMs: number }).requestTimeoutMs =
            5_000;

        await client.connect();

        const pending = client.send(
            GENERIC_REQUEST_PAYLOAD_TYPE,
            new Uint8Array(),
        );
        // Wait until the request has actually reached the wire (and is therefore registered
        // in pendingRequests) before disconnecting — otherwise this races client.send()'s own
        // async preamble instead of testing the disconnect-triggered rejection path.
        await requestReceivedPromise;

        const startedAt = Date.now();
        await client.disconnect();

        await expect(pending).rejects.toThrow(/connection was closed/i);
        expect(Date.now() - startedAt).toBeLessThan(1_000);
    });

    it('re-authenticates after an unexpected reconnect', async () => {
        const { client, nextServerSocket } = createTestClient(
            server,
            port,
            oauthClient,
            createdClients,
        );
        const firstConnection = nextServerSocket();

        const authenticated = vi.fn();
        client.on('authenticated', authenticated);

        await client.connect();
        expect(authenticated).toHaveBeenCalledOnce();

        const secondConnection = nextServerSocket();
        const serverSocket = await firstConnection;
        serverSocket.destroy();
        await secondConnection;

        await vi.waitFor(() => expect(authenticated).toHaveBeenCalledTimes(2), {
            timeout: 2000,
        });
    });

    it('refreshes an expiring token once for concurrent send() calls, not once per call', async () => {
        const refreshSpy = vi
            .spyOn(oauthClient, 'refreshAccessToken')
            .mockResolvedValue({
                accessToken: 'fresh-access-token',
                refreshToken: 'fresh-refresh-token',
                tokenType: 'bearer',
                expiresIn: 2_628_000,
            });

        const { client } = createTestClient(
            server,
            port,
            oauthClient,
            createdClients,
            {
                onOtherRequest: (request) =>
                    ProtoMessage.fromPartial({
                        payloadType: GENERIC_RESPONSE_PAYLOAD_TYPE,
                        payload: new Uint8Array(),
                        clientMsgId: request.clientMsgId,
                    }),
            },
        );

        await client.connect();
        // Force staleness *after* connect() so the dedup guard is what's under test here,
        // not the one-time refresh already covered by the connect-time auth handshake.
        (client as unknown as { tokenIssuedAt: number }).tokenIssuedAt = 0;

        await Promise.all([
            client.send(GENERIC_REQUEST_PAYLOAD_TYPE, new Uint8Array()),
            client.send(GENERIC_REQUEST_PAYLOAD_TYPE, new Uint8Array()),
        ]);

        expect(refreshSpy).toHaveBeenCalledOnce();
    });
});
