import * as net from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ProtoMessage, ProtoPayloadType } from '../../src/types';
import { encodeFrame, FrameDecoder } from '../../src/transport/frame-codec';
import { SpotwareHost, SpotwareTransport, type SpotwareSocketFactory } from '../../src/transport';

function createLoopbackSocketFactory(port: number): SpotwareSocketFactory {
    return () =>
        new Promise((resolve, reject) => {
            const socket = net.connect(port, '127.0.0.1');
            socket.once('connect', () => resolve(socket));
            socket.once('error', reject);
        });
}

describe('SpotwareTransport', () => {
    let server: net.Server;
    let port: number;

    beforeEach(async () => {
        server = net.createServer();
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        port = (server.address() as net.AddressInfo).port;
    });

    afterEach(async () => {
        await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    function createTransport(
        overrides: {
            socketFactory?: SpotwareSocketFactory;
            staleConnectionTimeoutMs?: number;
        } = {}
    ): SpotwareTransport {
        return new SpotwareTransport({
            host: SpotwareHost.DEMO,
            port,
            socketFactory: overrides.socketFactory ?? createLoopbackSocketFactory(port),
            reconnectBackoff: { baseDelayMs: 10, maxDelayMs: 20, factor: 2 },
            staleConnectionTimeoutMs: overrides.staleConnectionTimeoutMs
        });
    }

    it('connects and emits "connected"', async () => {
        const transport = createTransport();
        const connected = vi.fn();
        transport.on('connected', connected);

        await transport.connect();

        expect(connected).toHaveBeenCalledOnce();
        await transport.disconnect();
    });

    it('sends a framed ProtoMessage that the server can decode', async () => {
        const received = new Promise<Buffer>((resolve) => {
            server.once('connection', (socket) => {
                const decoder = new FrameDecoder();
                socket.on('data', (chunk: Buffer) => {
                    const frames = decoder.push(chunk);
                    if (frames.length > 0) {
                        resolve(frames[0]);
                    }
                });
            });
        });

        const transport = createTransport();
        await transport.connect();

        await transport.send(
            ProtoMessage.fromPartial({
                payloadType: ProtoPayloadType.HEARTBEAT_EVENT,
                clientMsgId: 'test-1'
            })
        );

        const decoded = ProtoMessage.decode(await received);
        expect(decoded.payloadType).toBe(ProtoPayloadType.HEARTBEAT_EVENT);
        expect(decoded.clientMsgId).toBe('test-1');

        await transport.disconnect();
    });

    it('emits "message" for frames pushed by the server', async () => {
        const connectionReceived = new Promise<net.Socket>((resolve) => server.once('connection', resolve));

        const transport = createTransport();
        const messageReceived = new Promise<ProtoMessage>((resolve) => transport.once('message', resolve));

        await transport.connect();
        const serverSocket = await connectionReceived;

        const outbound = ProtoMessage.fromPartial({
            payloadType: ProtoPayloadType.PROTO_MESSAGE,
            clientMsgId: 'from-server'
        });
        serverSocket.write(encodeFrame(ProtoMessage.encode(outbound).finish()));

        const received = await messageReceived;
        expect(received.clientMsgId).toBe('from-server');

        await transport.disconnect();
    });

    it('does not reconnect after an intentional disconnect', async () => {
        const transport = createTransport();
        const reconnecting = vi.fn();
        transport.on('reconnecting', reconnecting);

        await transport.connect();
        await transport.disconnect();

        // Give any stray reconnect scheduling a chance to fire, if the disconnect-intent guard were broken.
        await new Promise((resolve) => setTimeout(resolve, 50));

        expect(reconnecting).not.toHaveBeenCalled();
    });

    it('auto-reconnects with backoff after an unexpected drop, and recovers', async () => {
        const nextServerConnection = () => new Promise<net.Socket>((resolve) => server.once('connection', resolve));
        const firstServerConnection = nextServerConnection();

        const transport = createTransport();
        const connected = vi.fn();
        const reconnecting = vi.fn();
        const disconnected = vi.fn();
        transport.on('connected', connected);
        transport.on('reconnecting', reconnecting);
        transport.on('disconnected', disconnected);
        // A forced drop surfaces as ECONNRESET; any real consumer must handle 'error' too,
        // same as with a plain net.Socket. Recovery itself is asserted via 'reconnecting'/'connected'.
        transport.on('error', () => undefined);

        await transport.connect();
        const serverSocket = await firstServerConnection;

        serverSocket.destroy();

        await vi.waitFor(() => expect(connected).toHaveBeenCalledTimes(2), {
            timeout: 2000
        });

        expect(disconnected).toHaveBeenCalledWith('dropped');
        expect(reconnecting).toHaveBeenCalledTimes(1);

        await transport.disconnect();
    });

    it('does not auto-retry when the very first connect() attempt fails', async () => {
        const alwaysFailingFactory: SpotwareSocketFactory = async () => {
            throw new Error('simulated DNS failure');
        };

        const transport = createTransport({
            socketFactory: alwaysFailingFactory
        });
        const reconnecting = vi.fn();
        transport.on('reconnecting', reconnecting);
        transport.on('error', () => undefined);

        await expect(transport.connect()).rejects.toThrow('simulated DNS failure');

        // Give any stray reconnect scheduling a chance to fire, if this guard were broken.
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(reconnecting).not.toHaveBeenCalled();
    });

    it('keeps retrying with backoff when a reconnect attempt itself fails, not just the initial drop', async () => {
        // Regression test: a real socketFactory rejection (e.g. tls.connect failing on
        // getaddrinfo ENOTFOUND during an outage) has no socket to ever emit 'close' on, which
        // previously caused the retry loop to silently stop after exactly one failed attempt.
        const nextServerConnection = () => new Promise<net.Socket>((resolve) => server.once('connection', resolve));
        const firstServerConnection = nextServerConnection();

        const realFactory = createLoopbackSocketFactory(port);
        let attempts = 0;
        const flakyFactory: SpotwareSocketFactory = (p, h) => {
            attempts += 1;
            // 1st call: real initial connect. 2nd & 3rd (reconnect attempts): fail, simulating
            // the outage still being down. 4th+: succeed again, simulating the network returning.
            if (attempts === 2 || attempts === 3) {
                return Promise.reject(new Error('simulated DNS failure'));
            }
            return realFactory(p, h);
        };

        const transport = createTransport({ socketFactory: flakyFactory });
        const connected = vi.fn();
        const reconnecting = vi.fn();
        transport.on('connected', connected);
        transport.on('reconnecting', reconnecting);
        transport.on('error', () => undefined);

        await transport.connect();
        const serverSocket = await firstServerConnection;

        const secondServerConnection = nextServerConnection();
        serverSocket.destroy();
        await secondServerConnection;

        await vi.waitFor(() => expect(connected).toHaveBeenCalledTimes(2), {
            timeout: 3000
        });
        // 3 reconnect attempts scheduled: the 2 that failed, plus the 1 that finally succeeded.
        expect(reconnecting.mock.calls.length).toBeGreaterThanOrEqual(3);

        await transport.disconnect();
    });

    it('force-reconnects when the connection goes silent, even with no socket-level close or error', async () => {
        // Simulates a network outage: the server neither sends anything nor closes the
        // socket, so nothing at the TCP layer would ever notice on its own.
        const nextServerConnection = () => new Promise<net.Socket>((resolve) => server.once('connection', resolve));
        const firstServerConnection = nextServerConnection();

        const transport = createTransport({ staleConnectionTimeoutMs: 100 });
        const connected = vi.fn();
        const reconnecting = vi.fn();
        transport.on('connected', connected);
        transport.on('reconnecting', reconnecting);
        transport.on('error', () => undefined);

        await transport.connect();
        await firstServerConnection;

        await vi.waitFor(() => expect(connected).toHaveBeenCalledTimes(2), {
            timeout: 2000
        });
        expect(reconnecting).toHaveBeenCalledTimes(1);

        await transport.disconnect();
    });

    it('destroys a connection that completes after disconnect() was already called', async () => {
        let releaseSocket: ((socket: net.Socket) => void) | undefined;
        const transport = new SpotwareTransport({
            host: SpotwareHost.DEMO,
            port,
            socketFactory: () => new Promise<net.Socket>((resolve) => (releaseSocket = resolve))
        });
        transport.on('error', () => undefined);

        // disconnect() lands while the socket is still being established, so it finds nothing
        // to destroy. Without the attempt cleaning up after itself, the socket that arrives
        // next goes live with its heartbeat and watchdog running and nothing ever closes it.
        const connecting = transport.connect().catch(() => undefined);
        await transport.disconnect();

        const socket = net.connect(port, '127.0.0.1');
        await new Promise<void>((resolve) => socket.once('connect', () => resolve()));
        releaseSocket?.(socket);
        await connecting;

        await vi.waitFor(() => expect(socket.destroyed).toBe(true));
    });
});
