import { randomUUID } from 'node:crypto';

import type { SpotwareTransport } from '../transport';
import {
    ProtoErrorRes,
    ProtoOAAccountAuthReq,
    ProtoOAApplicationAuthReq,
    ProtoOACtidTraderAccount,
    ProtoOAErrorRes,
    ProtoOAGetAccountListByAccessTokenReq,
    ProtoOAGetAccountListByAccessTokenRes,
    ProtoOAPayloadType,
    ProtoMessage,
    ProtoPayloadType
} from '../types';
import { SpotwareSocketAuthError } from './spotware-socket-auth-error';

const DEFAULT_RESPONSE_TIMEOUT_MS = 10_000;

export interface ISpotwareSocketAuthenticatorOptions {
    responseTimeoutMs?: number;
}

/**
 * The socket half of the auth flow: ApplicationAuthReq, then GetAccountListByAccessTokenReq
 * (the only way to discover a ctidTraderAccountId from a bare access token), then
 * AccountAuthReq. Requires an already-connected transport; knows nothing about how the
 * access token itself was obtained.
 */
export class SpotwareSocketAuthenticator {
    private readonly responseTimeoutMs: number;

    constructor(
        private readonly transport: SpotwareTransport,
        options: ISpotwareSocketAuthenticatorOptions = {}
    ) {
        this.responseTimeoutMs = options.responseTimeoutMs ?? DEFAULT_RESPONSE_TIMEOUT_MS;
    }

    async authenticateApplication(clientId: string, clientSecret: string): Promise<void> {
        const request = ProtoOAApplicationAuthReq.fromPartial({ clientId, clientSecret });

        await this.sendAndAwait(
            ProtoMessage.fromPartial({
                payloadType: ProtoOAPayloadType.PROTO_OA_APPLICATION_AUTH_REQ,
                payload: ProtoOAApplicationAuthReq.encode(request).finish()
            }),
            ProtoOAPayloadType.PROTO_OA_APPLICATION_AUTH_RES
        );
    }

    async listAccounts(accessToken: string): Promise<ProtoOACtidTraderAccount[]> {
        const request = ProtoOAGetAccountListByAccessTokenReq.fromPartial({ accessToken });

        const response = await this.sendAndAwait(
            ProtoMessage.fromPartial({
                payloadType: ProtoOAPayloadType.PROTO_OA_GET_ACCOUNTS_BY_ACCESS_TOKEN_REQ,
                payload: ProtoOAGetAccountListByAccessTokenReq.encode(request).finish()
            }),
            ProtoOAPayloadType.PROTO_OA_GET_ACCOUNTS_BY_ACCESS_TOKEN_RES
        );

        return ProtoOAGetAccountListByAccessTokenRes.decode(response.payload ?? new Uint8Array()).ctidTraderAccount;
    }

    async authenticateAccount(ctidTraderAccountId: number, accessToken: string): Promise<void> {
        const request = ProtoOAAccountAuthReq.fromPartial({ ctidTraderAccountId, accessToken });

        await this.sendAndAwait(
            ProtoMessage.fromPartial({
                payloadType: ProtoOAPayloadType.PROTO_OA_ACCOUNT_AUTH_REQ,
                payload: ProtoOAAccountAuthReq.encode(request).finish()
            }),
            ProtoOAPayloadType.PROTO_OA_ACCOUNT_AUTH_RES
        );
    }

    private sendAndAwait(message: ProtoMessage, expectedPayloadType: ProtoOAPayloadType): Promise<ProtoMessage> {
        const clientMsgId = randomUUID();

        return new Promise((resolve, reject) => {
            let timeout: NodeJS.Timeout;

            const cleanup = () => {
                clearTimeout(timeout);
                this.transport.off('message', onMessage);
            };

            const onMessage = (received: ProtoMessage) => {
                // Two handshakes can overlap on one socket (e.g. a reconnect firing while the
                // previous attempt is still in flight), and both would be waiting on the same
                // payloadType. Without this, one response would settle both — leaving an
                // account that never got a reply believing it is authenticated.
                if (received.clientMsgId && received.clientMsgId !== clientMsgId) {
                    return;
                }

                if (received.payloadType === expectedPayloadType) {
                    cleanup();
                    resolve(received);
                    return;
                }

                if (received.payloadType === ProtoOAPayloadType.PROTO_OA_ERROR_RES) {
                    const error = ProtoOAErrorRes.decode(received.payload ?? new Uint8Array());
                    cleanup();
                    reject(new SpotwareSocketAuthError(error.description ?? error.errorCode, error.errorCode));
                    return;
                }

                if (received.payloadType === ProtoPayloadType.ERROR_RES) {
                    const error = ProtoErrorRes.decode(received.payload ?? new Uint8Array());
                    cleanup();
                    reject(new SpotwareSocketAuthError(error.description ?? error.errorCode, error.errorCode));
                }
            };

            timeout = setTimeout(() => {
                cleanup();
                reject(new SpotwareSocketAuthError(`Timed out waiting for payloadType ${expectedPayloadType}`));
            }, this.responseTimeoutMs);

            this.transport.on('message', onMessage);
            this.transport.send(ProtoMessage.fromPartial({ ...message, clientMsgId })).catch((error: Error) => {
                cleanup();
                reject(error);
            });
        });
    }
}
