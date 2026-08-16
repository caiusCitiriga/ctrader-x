import * as net from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SpotwareSocketAuthError } from '../../src/auth/spotware-socket-auth-error';
import { SpotwareSocketAuthenticator } from '../../src/auth/spotware-socket-authenticator';
import { encodeFrame, FrameDecoder } from '../../src/transport/frame-codec';
import { SpotwareHost, SpotwareTransport, type SpotwareSocketFactory } from '../../src/transport';
import {
    ProtoErrorRes,
    ProtoMessage,
    ProtoOAAccountAuthRes,
    ProtoOAApplicationAuthRes,
    ProtoOACtidTraderAccount,
    ProtoOAErrorRes,
    ProtoOAGetAccountListByAccessTokenRes,
    ProtoOAPayloadType,
    ProtoPayloadType
} from '../../src/types';

function createLoopbackSocketFactory(port: number): SpotwareSocketFactory {
    return () =>
        new Promise((resolve, reject) => {
            const socket = net.connect(port, '127.0.0.1');
            socket.once('connect', () => resolve(socket));
            socket.once('error', reject);
        });
}

describe('SpotwareSocketAuthenticator', () => {
    let server: net.Server;
    let transport: SpotwareTransport;
    let serverSocket: net.Socket;

    beforeEach(async () => {
        server = net.createServer();
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        const port = (server.address() as net.AddressInfo).port;

        const connectionReceived = new Promise<net.Socket>((resolve) => server.once('connection', resolve));

        transport = new SpotwareTransport({ host: SpotwareHost.DEMO, port, socketFactory: createLoopbackSocketFactory(port) });
        transport.on('error', () => undefined);

        const [, socket] = await Promise.all([transport.connect(), connectionReceived]);
        serverSocket = socket;
        // A server-side socket with no 'data' listener stays paused and never notices the
        // peer disconnecting, which hangs server.close() in afterEach for tests that never
        // call respondOnce() (e.g. the timeout test). Force it into flowing mode up front.
        serverSocket.resume();
    });

    afterEach(async () => {
        await transport.disconnect();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    // Decodes the next request the fake server receives and lets the test build the reply,
    // mirroring how a real cTrader server would respond over the same connection.
    function respondOnce(build: (request: ProtoMessage) => ProtoMessage): void {
        const decoder = new FrameDecoder();
        const onData = (chunk: Buffer) => {
            for (const frame of decoder.push(chunk)) {
                const response = build(ProtoMessage.decode(frame));
                serverSocket.write(encodeFrame(ProtoMessage.encode(response).finish()));
                serverSocket.off('data', onData);
            }
        };
        serverSocket.on('data', onData);
    }

    it('authenticates the application', async () => {
        respondOnce((request) => {
            expect(request.payloadType).toBe(ProtoOAPayloadType.PROTO_OA_APPLICATION_AUTH_REQ);
            return ProtoMessage.fromPartial({
                payloadType: ProtoOAPayloadType.PROTO_OA_APPLICATION_AUTH_RES,
                payload: ProtoOAApplicationAuthRes.encode(ProtoOAApplicationAuthRes.fromPartial({})).finish()
            });
        });

        const authenticator = new SpotwareSocketAuthenticator(transport);
        await expect(authenticator.authenticateApplication('client-id', 'client-secret')).resolves.toBeUndefined();
    });

    it('rejects with a typed error on PROTO_OA_ERROR_RES', async () => {
        respondOnce(() =>
            ProtoMessage.fromPartial({
                payloadType: ProtoOAPayloadType.PROTO_OA_ERROR_RES,
                payload: ProtoOAErrorRes.encode(
                    ProtoOAErrorRes.fromPartial({ errorCode: 'INVALID_CLIENT', description: 'bad client secret' })
                ).finish()
            })
        );

        const authenticator = new SpotwareSocketAuthenticator(transport);
        await expect(authenticator.authenticateApplication('client-id', 'wrong-secret')).rejects.toMatchObject({
            message: 'bad client secret',
            errorCode: 'INVALID_CLIENT'
        });
    });

    it('rejects with a typed error on the generic ERROR_RES', async () => {
        respondOnce(() =>
            ProtoMessage.fromPartial({
                payloadType: ProtoPayloadType.ERROR_RES,
                payload: ProtoErrorRes.encode(ProtoErrorRes.fromPartial({ errorCode: 'FRAME_TOO_LONG' })).finish()
            })
        );

        const authenticator = new SpotwareSocketAuthenticator(transport);
        await expect(authenticator.authenticateApplication('client-id', 'client-secret')).rejects.toBeInstanceOf(SpotwareSocketAuthError);
    });

    it('lists the accounts linked to an access token', async () => {
        respondOnce((request) => {
            expect(request.payloadType).toBe(ProtoOAPayloadType.PROTO_OA_GET_ACCOUNTS_BY_ACCESS_TOKEN_REQ);
            return ProtoMessage.fromPartial({
                payloadType: ProtoOAPayloadType.PROTO_OA_GET_ACCOUNTS_BY_ACCESS_TOKEN_RES,
                payload: ProtoOAGetAccountListByAccessTokenRes.encode(
                    ProtoOAGetAccountListByAccessTokenRes.fromPartial({
                        accessToken: 'access-token',
                        ctidTraderAccount: [ProtoOACtidTraderAccount.fromPartial({ ctidTraderAccountId: 123, isLive: false })]
                    })
                ).finish()
            });
        });

        const authenticator = new SpotwareSocketAuthenticator(transport);
        const accounts = await authenticator.listAccounts('access-token');

        expect(accounts).toHaveLength(1);
        expect(accounts[0]?.ctidTraderAccountId).toBe(123);
        expect(accounts[0]?.isLive).toBe(false);
    });

    it('authenticates a specific account', async () => {
        respondOnce((request) => {
            expect(request.payloadType).toBe(ProtoOAPayloadType.PROTO_OA_ACCOUNT_AUTH_REQ);
            return ProtoMessage.fromPartial({
                payloadType: ProtoOAPayloadType.PROTO_OA_ACCOUNT_AUTH_RES,
                payload: ProtoOAAccountAuthRes.encode(ProtoOAAccountAuthRes.fromPartial({ ctidTraderAccountId: 123 })).finish()
            });
        });

        const authenticator = new SpotwareSocketAuthenticator(transport);
        await expect(authenticator.authenticateAccount(123, 'access-token')).resolves.toBeUndefined();
    });

    it('times out when the server never responds', async () => {
        const authenticator = new SpotwareSocketAuthenticator(transport, { responseTimeoutMs: 50 });

        await expect(authenticator.authenticateApplication('client-id', 'client-secret')).rejects.toThrow(/Timed out/);
    });
});
