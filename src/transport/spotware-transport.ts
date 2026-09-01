import * as tls from 'node:tls';
import type { Duplex } from 'node:stream';

import { TypedEventEmitter, type EventMap } from '../shared/typed-event-emitter';
import { ProtoHeartbeatEvent, ProtoMessage, ProtoPayloadType } from '../types';
import { encodeFrame, FrameDecoder } from './frame-codec';
import { calculateReconnectDelayMs, DEFAULT_RECONNECT_BACKOFF_OPTIONS, type IReconnectBackoffOptions } from './reconnect-backoff';
import { SpotwareRateLimiter } from './spotware-rate-limiter';
import { SPOTWARE_PORT, SpotwareHost } from './spotware-host.enum';

// https://connect.spotware.com/docs/frequently-asked-questions
const HEARTBEAT_INTERVAL_MS = 10_000;

// A silent network outage (e.g. wifi drop) produces no 'close'/'error' event on its own —
// TCP only notices once something tries to use the connection, which can take many minutes
// via the OS's own retransmission timeout. These make the transport notice on its own by
// tracking inbound activity instead of waiting on the socket to fail.
const DEFAULT_STALE_CONNECTION_TIMEOUT_MS = 30_000;
const MIN_LIVENESS_CHECK_INTERVAL_MS = 50;
const TCP_KEEPALIVE_INITIAL_DELAY_MS = 10_000;

export type SpotwareDisconnectReason = 'manual' | 'dropped';

/**
 * Resolves once the connection is fully ready to use (e.g. after the TLS handshake).
 * Lets tests substitute a plain local TCP server without touching any transport logic.
 */
export type SpotwareSocketFactory = (port: number, host: string) => Promise<Duplex>;

const defaultSocketFactory: SpotwareSocketFactory = (port, host) =>
    new Promise((resolve, reject) => {
        const socket = tls.connect(port, host);
        socket.setKeepAlive(true, TCP_KEEPALIVE_INITIAL_DELAY_MS);

        const onSecureConnect = () => {
            socket.off('error', onError);
            resolve(socket);
        };

        const onError = (error: Error) => {
            socket.off('secureConnect', onSecureConnect);
            reject(error);
        };

        socket.once('secureConnect', onSecureConnect);
        socket.once('error', onError);
    });

export interface ISpotwareTransportEvents extends EventMap {
    connected: [];
    disconnected: [reason: SpotwareDisconnectReason];
    reconnecting: [attempt: number, delayMs: number];
    message: [message: ProtoMessage];
    error: [error: Error];
}

export interface ISpotwareTransportOptions {
    host: SpotwareHost;
    port?: number;
    reconnectBackoff?: IReconnectBackoffOptions;
    socketFactory?: SpotwareSocketFactory;
    staleConnectionTimeoutMs?: number;
}

/**
 * Opens the TCP/TLS connection to a cTrader host, frames Protobuf messages on the wire,
 * and auto-reconnects with backoff on any drop that wasn't requested via disconnect().
 * Knows nothing about auth or trading: messages are passed through as the raw ProtoMessage
 * envelope, undecoded, for the client module to interpret.
 */
export class SpotwareTransport extends TypedEventEmitter<ISpotwareTransportEvents> {
    private readonly host: SpotwareHost;
    private readonly port: number;
    private readonly reconnectBackoffOptions: IReconnectBackoffOptions;
    private readonly socketFactory: SpotwareSocketFactory;
    private readonly staleConnectionTimeoutMs: number;
    private readonly livenessCheckIntervalMs: number;
    private readonly rateLimiter = new SpotwareRateLimiter();

    private socket: Duplex | undefined;
    private heartbeatTimer: NodeJS.Timeout | undefined;
    private livenessTimer: NodeJS.Timeout | undefined;
    private reconnectTimer: NodeJS.Timeout | undefined;
    private reconnectAttempt = 0;
    private disconnectRequested = false;
    private lastMessageReceivedAt = 0;
    // Distinguishes "the first connect() call failed" (surfaced to the caller, not retried —
    // likely a config problem) from "a reconnect attempt failed" (kept retrying — we already
    // know this target is reachable, so a transient failure like a DNS blip during an outage
    // shouldn't stop the retry loop).
    private hasConnectedOnce = false;

    constructor(options: ISpotwareTransportOptions) {
        super();
        this.host = options.host;
        this.port = options.port ?? SPOTWARE_PORT;
        this.reconnectBackoffOptions = options.reconnectBackoff ?? DEFAULT_RECONNECT_BACKOFF_OPTIONS;
        this.socketFactory = options.socketFactory ?? defaultSocketFactory;
        this.staleConnectionTimeoutMs = options.staleConnectionTimeoutMs ?? DEFAULT_STALE_CONNECTION_TIMEOUT_MS;
        this.livenessCheckIntervalMs = Math.max(MIN_LIVENESS_CHECK_INTERVAL_MS, Math.floor(this.staleConnectionTimeoutMs / 6));
    }

    connect(): Promise<void> {
        this.disconnectRequested = false;
        this.clearReconnectTimer();
        return this.attemptConnection();
    }

    async disconnect(): Promise<void> {
        this.disconnectRequested = true;
        this.hasConnectedOnce = false;
        this.clearReconnectTimer();
        this.stopHeartbeat();
        this.stopLivenessWatchdog();
        this.rateLimiter.dispose();

        const socket = this.socket;
        if (!socket || socket.destroyed) {
            return;
        }

        await new Promise<void>((resolve) => {
            socket.once('close', () => resolve());
            socket.destroy();
        });
    }

    async send(message: ProtoMessage): Promise<void> {
        const socket = this.socket;
        if (!socket || socket.destroyed) {
            throw new Error('Cannot send a message while the transport is disconnected');
        }

        await this.rateLimiter.throttle(message.payloadType);

        const frame = encodeFrame(ProtoMessage.encode(message).finish());

        await new Promise<void>((resolve, reject) => {
            socket.write(frame, (error) => (error ? reject(error) : resolve()));
        });
    }

    private async attemptConnection(): Promise<void> {
        let socket: Duplex;

        try {
            socket = await this.socketFactory(this.port, this.host);
        } catch (error) {
            this.emit('error', error as Error);
            // A reconnect attempt that fails (e.g. DNS still down mid-outage) has no socket to
            // ever emit 'close' on, so scheduleReconnect() must be triggered here directly —
            // otherwise the retry loop silently dies on the first failed reconnect attempt.
            if (this.hasConnectedOnce && !this.disconnectRequested) {
                this.scheduleReconnect();
            }
            throw error;
        }

        // disconnect() can land while the socket is still being established: it finds no socket
        // to destroy and returns straight away, so this attempt has to clean up after itself.
        // Otherwise an explicit disconnect leaves a live socket with its heartbeat and watchdog
        // running, and the process never becomes idle.
        if (this.disconnectRequested) {
            socket.destroy();
            return;
        }

        this.socket = socket;
        this.hasConnectedOnce = true;
        this.reconnectAttempt = 0;
        this.lastMessageReceivedAt = Date.now();

        const frameDecoder = new FrameDecoder();
        socket.on('data', (chunk: Buffer) => this.handleData(frameDecoder, chunk));
        socket.once('error', (error: Error) => this.emit('error', error));
        socket.once('close', () => this.handleClose());

        this.startHeartbeat();
        this.startLivenessWatchdog();
        this.emit('connected');
    }

    private handleData(frameDecoder: FrameDecoder, chunk: Buffer): void {
        this.lastMessageReceivedAt = Date.now();
        let frames: Buffer[];

        try {
            frames = frameDecoder.push(chunk);
        } catch (error) {
            // destroy(error) alone is enough: it triggers the socket's own 'error' listener,
            // which already forwards to this.emit('error', ...) — emitting here too would
            // double-fire the same error.
            this.socket?.destroy(error as Error);
            return;
        }

        for (const frame of frames) {
            this.emit('message', ProtoMessage.decode(frame));
        }
    }

    private handleClose(): void {
        this.stopHeartbeat();
        this.stopLivenessWatchdog();
        this.emit('disconnected', this.disconnectRequested ? 'manual' : 'dropped');

        if (this.disconnectRequested) {
            return;
        }

        this.scheduleReconnect();
    }

    private scheduleReconnect(): void {
        const delayMs = calculateReconnectDelayMs(this.reconnectAttempt, this.reconnectBackoffOptions);
        this.reconnectAttempt += 1;

        this.emit('reconnecting', this.reconnectAttempt, delayMs);

        this.reconnectTimer = setTimeout(() => {
            // A failed attempt here re-triggers this same path via that socket's own 'close' event.
            this.attemptConnection().catch(() => undefined);
        }, delayMs);
    }

    private clearReconnectTimer(): void {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = undefined;
        }
    }

    private startHeartbeat(): void {
        this.heartbeatTimer = setInterval(() => {
            this.send(this.buildHeartbeatMessage()).catch((error: Error) => this.emit('error', error));
        }, HEARTBEAT_INTERVAL_MS);
    }

    // A silent network outage never fires 'close'/'error' on its own, so this actively
    // notices instead of waiting for the OS to eventually give up on the socket.
    private startLivenessWatchdog(): void {
        this.livenessTimer = setInterval(() => {
            const idleForMs = Date.now() - this.lastMessageReceivedAt;
            if (idleForMs > this.staleConnectionTimeoutMs) {
                this.socket?.destroy(new Error(`No data received for ${idleForMs}ms; treating the connection as dead`));
            }
        }, this.livenessCheckIntervalMs);
    }

    private stopLivenessWatchdog(): void {
        if (this.livenessTimer) {
            clearInterval(this.livenessTimer);
            this.livenessTimer = undefined;
        }
    }

    private stopHeartbeat(): void {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = undefined;
        }
    }

    private buildHeartbeatMessage(): ProtoMessage {
        return ProtoMessage.fromPartial({
            payloadType: ProtoPayloadType.HEARTBEAT_EVENT,
            payload: ProtoHeartbeatEvent.encode(ProtoHeartbeatEvent.fromPartial({})).finish()
        });
    }
}
