import {
    ProtoOAPayloadType,
    SpotwareClientSocket,
} from '@claasahl/spotware-adapter';
import { sendAndWait } from './socket-util';
import { Logger } from './logger';

export interface AuthParams {
    clientId: string;
    clientSecret: string;

    accessToken: string;
    ctidTraderAccountId: number;
}

export class AuthManager {
    private authenticated = false;
    private authParams!: AuthParams;

    constructor(private readonly spotwareClient: SpotwareClientSocket) {}

    get isAuthenticated() {
        return this.authenticated;
    }

    get ctidTraderAccountId() {
        return this.authParams?.ctidTraderAccountId;
    }

    async authenticate(params: AuthParams) {
        Logger.debug(`Authenticating application...`);
        try {
            await sendAndWait(
                this.spotwareClient,
                {
                    payloadType:
                        ProtoOAPayloadType.PROTO_OA_APPLICATION_AUTH_REQ,
                    payload: {
                        clientId: params.clientId,
                        clientSecret: params.clientSecret,
                    },
                },
                ProtoOAPayloadType.PROTO_OA_APPLICATION_AUTH_RES,
            );
        } catch (error: any) {
            Logger.error(
                `Application authentication failed: ${JSON.stringify(error)}`,
            );
            return false;
        }

        Logger.debug(`Application authenticated successfully`);

        Logger.debug(`Authenticating account...`);
        Logger.debug(
            `SPOTWARE__CTID_TRADER_ACCOUNT_ID: ${params.ctidTraderAccountId}`,
        );
        try {
            await sendAndWait(
                this.spotwareClient,
                {
                    payloadType: ProtoOAPayloadType.PROTO_OA_ACCOUNT_AUTH_REQ,
                    payload: {
                        accessToken: params.accessToken,
                        ctidTraderAccountId: params.ctidTraderAccountId,
                    },
                },
                ProtoOAPayloadType.PROTO_OA_ACCOUNT_AUTH_RES,
            );

            Logger.debug(`Account authenticated successfully`);
        } catch (error) {
            Logger.error(
                `Account authentication failed: ${JSON.stringify(error)}`,
            );
            return false;
        }

        this.authParams = params;
        this.authenticated = true;
        return this.authenticated;
    }
}
