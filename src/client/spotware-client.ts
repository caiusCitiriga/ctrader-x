import { randomUUID } from 'node:crypto';

import { SpotwareOAuthClient, SpotwareSocketAuthenticator, type ISpotwareOAuthToken } from '../auth';
import { TypedEventEmitter, type EventMap } from '../shared/typed-event-emitter';
import { ProtoErrorRes, ProtoMessage, ProtoOAErrorRes, ProtoOAOrderErrorEvent, ProtoOAPayloadType, ProtoPayloadType } from '../types';
import type { SpotwareTransport } from '../transport';
import { SpotwareRequestError } from './spotware-request-error';

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_TOKEN_REFRESH_BUFFER_MS = 5 * 60_000;

interface IPendingRequest {
    resolve: (message: ProtoMessage) => void;
    reject: (error: Error) => void;
}

export interface ISpotwareClientOptions {
    transport: SpotwareTransport;
    oauthClient: SpotwareOAuthClient;
    clientId: string;
    clientSecret: string;
    ctidTraderAccountId: number;
    token: ISpotwareOAuthToken;
    requestTimeoutMs?: number;
    tokenRefreshBufferMs?: number;
}

export interface ISpotwareClientEvents extends EventMap {
    authenticated: [];
    tokenRefreshed: [token: ISpotwareOAuthToken];
    message: [message: ProtoMessage];
    error: [error: Error];
}

/**
 * Request/response correlation on top of transport + auth: `send()` tags each request with a
 * clientMsgId and resolves once the matching response arrives, refreshing the access token
 * first if it's close to expiry. Re-runs the app/account auth handshake on every transport
 * 'connected' event, including reconnects, since a fresh TCP connection has no socket-level
 * auth state. Doesn't know what an order or a price is — every unsolicited message (spot
 * events, etc.) is just forwarded as-is via the 'message' event for market-data/trading to
 * interpret.
 */
export class SpotwareClient extends TypedEventEmitter<ISpotwareClientEvents> {
    private readonly transport: SpotwareTransport;
    private readonly oauthClient: SpotwareOAuthClient;
    private readonly authenticator: SpotwareSocketAuthenticator;
    private readonly clientId: string;
    private readonly clientSecret: string;
    private readonly _ctidTraderAccountId: number;
    private readonly requestTimeoutMs: number;
    private readonly tokenRefreshBufferMs: number;

    private readonly pendingRequests = new Map<string, IPendingRequest>();
    private token: ISpotwareOAuthToken;
    private tokenIssuedAt = Date.now();
    private tokenRefreshInFlight: Promise<void> | undefined;
    private authenticationInFlight: Promise<void> | undefined;

    constructor(options: ISpotwareClientOptions) {
        super();
        this.transport = options.transport;
        this.oauthClient = options.oauthClient;
        this.clientId = options.clientId;
        this.clientSecret = options.clientSecret;
        this._ctidTraderAccountId = options.ctidTraderAccountId;
        this.token = options.token;
        this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
        this.tokenRefreshBufferMs = options.tokenRefreshBufferMs ?? DEFAULT_TOKEN_REFRESH_BUFFER_MS;
        this.authenticator = new SpotwareSocketAuthenticator(this.transport, { responseTimeoutMs: this.requestTimeoutMs });

        this.transport.on('connected', () => this.handleConnected());
        this.transport.on('message', (message) => this.handleMessage(message));
        this.transport.on('error', (error) => this.emit('error', error));
        this.transport.on('disconnected', (reason) => {
            const message = reason === 'manual' ? 'The connection was closed' : 'The connection was lost';
            this.rejectPendingRequests(new SpotwareRequestError(`${message} while waiting for a response`));
        });
    }

    get ctidTraderAccountId(): number {
        return this._ctidTraderAccountId;
    }

    async connect(): Promise<void> {
        await this.transport.connect();
        await this.authenticationInFlight;
    }

    disconnect(): Promise<void> {
        return this.transport.disconnect();
    }

    async send(payloadType: number, payload: Uint8Array): Promise<ProtoMessage> {
        if (this.authenticationInFlight) {
            await this.authenticationInFlight;
        }

        await this.ensureValidToken();

        const clientMsgId = randomUUID();

        return new Promise<ProtoMessage>((resolve, reject) => {
            let timeout: NodeJS.Timeout;

            const settle = (pending: IPendingRequest) => {
                this.pendingRequests.set(clientMsgId, pending);
            };

            const cleanup = () => {
                clearTimeout(timeout);
                this.pendingRequests.delete(clientMsgId);
            };

            settle({
                resolve: (message) => {
                    cleanup();
                    resolve(message);
                },
                reject: (error) => {
                    cleanup();
                    reject(error);
                }
            });

            timeout = setTimeout(() => {
                this.pendingRequests.get(clientMsgId)?.reject(new SpotwareRequestError(`Timed out waiting for a response to "${clientMsgId}"`));
            }, this.requestTimeoutMs);

            this.transport.send(ProtoMessage.fromPartial({ payloadType, payload, clientMsgId })).catch((error: Error) => {
                this.pendingRequests.get(clientMsgId)?.reject(error);
            });
        });
    }

    // Fires on the first connect and on every auto-reconnect: a new TCP connection has no
    // socket-level auth state, so this re-establishes it every time, not just once.
    private handleConnected(): void {
        // Left set after settling rather than cleared: awaiting an already-settled promise
        // is a harmless no-op, and clearing it here would race connect()'s own await below
        // on an unrealistically fast (but not impossible) authentication.
        const attempt = this.authenticate();
        this.authenticationInFlight = attempt;
        attempt.catch((error: Error) => this.emit('error', error));
    }

    private async authenticate(): Promise<void> {
        await this.ensureValidToken();
        await this.authenticator.authenticateApplication(this.clientId, this.clientSecret);
        await this.authenticator.authenticateAccount(this._ctidTraderAccountId, this.token.accessToken);
        this.emit('authenticated');
    }

    private handleMessage(message: ProtoMessage): void {
        this.emit('message', message);

        const pending = message.clientMsgId ? this.pendingRequests.get(message.clientMsgId) : undefined;
        if (!pending) {
            return;
        }

        if (message.payloadType === ProtoOAPayloadType.PROTO_OA_ERROR_RES) {
            const error = ProtoOAErrorRes.decode(message.payload ?? new Uint8Array());
            pending.reject(new SpotwareRequestError(error.description ?? error.errorCode, error.errorCode));
            return;
        }

        if (message.payloadType === ProtoPayloadType.ERROR_RES) {
            const error = ProtoErrorRes.decode(message.payload ?? new Uint8Array());
            pending.reject(new SpotwareRequestError(error.description ?? error.errorCode, error.errorCode));
            return;
        }

        // Order mutations (new/amend/cancel/close) have no dedicated _Res message: the outcome
        // arrives as an ExecutionEvent (success) or this event (failure), both carrying the
        // same clientMsgId. Without this, a rejected order would resolve as if it succeeded.
        if (message.payloadType === ProtoOAPayloadType.PROTO_OA_ORDER_ERROR_EVENT) {
            const error = ProtoOAOrderErrorEvent.decode(message.payload ?? new Uint8Array());
            pending.reject(new SpotwareRequestError(error.description ?? error.errorCode, error.errorCode));
            return;
        }

        pending.resolve(message);
    }

    // Called when the transport disconnects for any reason, so in-flight requests fail
    // immediately with a clear cause instead of each waiting out its own full timeout for
    // a response that can no longer arrive.
    private rejectPendingRequests(error: Error): void {
        for (const pending of [...this.pendingRequests.values()]) {
            pending.reject(error);
        }
    }

    // Refresh tokens are single-use: concurrent callers must await the same in-flight
    // refresh rather than each requesting their own, which would invalidate the others.
    private async ensureValidToken(): Promise<void> {
        if (this.tokenRefreshInFlight) {
            await this.tokenRefreshInFlight;
            return;
        }

        const expiresAt = this.tokenIssuedAt + this.token.expiresIn * 1000;
        if (Date.now() < expiresAt - this.tokenRefreshBufferMs) {
            return;
        }

        this.tokenRefreshInFlight = this.refreshToken();
        try {
            await this.tokenRefreshInFlight;
        } finally {
            this.tokenRefreshInFlight = undefined;
        }
    }

    private async refreshToken(): Promise<void> {
        this.token = await this.oauthClient.refreshAccessToken({ refreshToken: this.token.refreshToken });
        this.tokenIssuedAt = Date.now();
        this.emit('tokenRefreshed', this.token);
    }
}
