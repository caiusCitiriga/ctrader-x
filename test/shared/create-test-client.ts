import * as net from 'node:net';

import { SpotwareOAuthClient } from '../../src/auth';
import { SpotwareClient } from '../../src/client';
import {
    SpotwareHost,
    SpotwareTransport,
    type SpotwareSocketFactory,
} from '../../src/transport';
import type { ProtoMessage, ProtoOALightSymbol } from '../../src/types';
import { TEST_ACCOUNT_ID, wireFakeServer } from './fake-spotware-server';

function createLoopbackSocketFactory(port: number): SpotwareSocketFactory {
    return () =>
        new Promise((resolve, reject) => {
            const socket = net.connect(port, '127.0.0.1');
            socket.once('connect', () => resolve(socket));
            socket.once('error', reject);
        });
}

export interface ITestClientHarness {
    client: SpotwareClient;
    nextServerSocket(): Promise<net.Socket>;
}

export function createTestClient(
    server: net.Server,
    port: number,
    createdClients: SpotwareClient[],
    options: {
        symbols?: ProtoOALightSymbol[];
        onOtherRequest?: (request: ProtoMessage) => ProtoMessage | undefined;
        shouldRespond?: (request: ProtoMessage) => boolean;
    } = {},
): ITestClientHarness {
    let pendingResolvers: Array<(socket: net.Socket) => void> = [];

    server.removeAllListeners('connection');
    server.on('connection', (socket) => {
        wireFakeServer(socket, options);
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
        oauthClient: new SpotwareOAuthClient({
            clientId: 'client-id',
            clientSecret: 'client-secret',
        }),
        clientId: 'client-id',
        clientSecret: 'client-secret',
        ctidTraderAccountId: TEST_ACCOUNT_ID,
        token: {
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
