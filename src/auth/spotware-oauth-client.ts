import {
    SPOTWARE_OAUTH_AUTHORIZE_URL,
    SPOTWARE_OAUTH_TOKEN_URL,
} from './spotware-oauth-endpoints';
import { SpotwareOAuthError } from './spotware-oauth-error';
import { SpotwareOAuthScope } from './spotware-oauth-scope.enum';
import type { ISpotwareOAuthToken } from './spotware-oauth-token.model';

export interface ISpotwareOAuthClientOptions {
    clientId: string;
    clientSecret: string;
}

export interface IBuildAuthorizationUrlParams {
    redirectUri: string;
    scope: SpotwareOAuthScope;
}

export interface IExchangeAuthorizationCodeParams {
    code: string;
    redirectUri: string;
}

export interface IRefreshAccessTokenParams {
    refreshToken: string;
}

interface ISpotwareTokenResponsePayload {
    accessToken?: string;
    refreshToken?: string;
    tokenType?: string;
    expiresIn?: number;
    errorCode?: string;
    description?: string;
}

/**
 * The HTTP half of the OAuth2 flow: builds the authorization URL, exchanges the
 * redirect code for tokens, and refreshes the access token. Knows nothing about
 * the TCP socket or the ApplicationAuthReq/AccountAuthReq handshake.
 */
export class SpotwareOAuthClient {
    constructor(private readonly options: ISpotwareOAuthClientOptions) {}

    buildAuthorizationUrl({
        redirectUri,
        scope,
    }: IBuildAuthorizationUrlParams): string {
        const url = new URL(SPOTWARE_OAUTH_AUTHORIZE_URL);
        url.searchParams.set('client_id', this.options.clientId);
        url.searchParams.set('redirect_uri', redirectUri);
        url.searchParams.set('scope', scope);

        return url.toString();
    }

    exchangeAuthorizationCode({
        code,
        redirectUri,
    }: IExchangeAuthorizationCodeParams): Promise<ISpotwareOAuthToken> {
        return this.requestToken({
            grant_type: 'authorization_code',
            code,
            redirect_uri: redirectUri,
        });
    }

    refreshAccessToken({
        refreshToken,
    }: IRefreshAccessTokenParams): Promise<ISpotwareOAuthToken> {
        return this.requestToken({
            grant_type: 'refresh_token',
            refresh_token: refreshToken,
        });
    }

    // Spotware's token endpoint takes these as GET query params, client_secret included,
    // matching their own SDKs. Not our choice of contract, just theirs to interop with.
    private async requestToken(
        params: Record<string, string>,
    ): Promise<ISpotwareOAuthToken> {
        const url = new URL(SPOTWARE_OAUTH_TOKEN_URL);
        for (const [key, value] of Object.entries(params)) {
            url.searchParams.set(key, value);
        }
        url.searchParams.set('client_id', this.options.clientId);
        url.searchParams.set('client_secret', this.options.clientSecret);

        let response: Response;
        try {
            response = await fetch(url);
        } catch (error) {
            throw new SpotwareOAuthError(
                `Failed to reach the Spotware token endpoint: ${(error as Error).message}`,
            );
        }

        const payload =
            (await response.json()) as ISpotwareTokenResponsePayload;

        if (!response.ok || !payload.accessToken || !payload.refreshToken) {
            throw new SpotwareOAuthError(
                payload.description ??
                    `Spotware token request failed with HTTP ${response.status}`,
                payload.errorCode,
                response.status,
            );
        }

        return {
            accessToken: payload.accessToken,
            refreshToken: payload.refreshToken,
            tokenType: payload.tokenType ?? 'bearer',
            expiresIn: payload.expiresIn ?? 0,
        };
    }
}
