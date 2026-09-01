import { afterEach, describe, expect, it, vi } from 'vitest';

import { SpotwareOAuthClient } from '../../src/auth/spotware-oauth-client';
import { SpotwareOAuthError } from '../../src/auth/spotware-oauth-error';
import { SpotwareOAuthScope } from '../../src/auth/spotware-oauth-scope.enum';

const client = new SpotwareOAuthClient({
    clientId: 'client-id',
    clientSecret: 'client-secret',
});

describe('SpotwareOAuthClient', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('builds the authorization URL with the required query parameters', () => {
        const url = new URL(
            client.buildAuthorizationUrl({
                redirectUri: 'http://localhost:8080/callback',
                scope: SpotwareOAuthScope.TRADING,
            }),
        );

        expect(url.origin + url.pathname).toBe(
            'https://openapi.ctrader.com/apps/auth',
        );
        expect(url.searchParams.get('client_id')).toBe('client-id');
        expect(url.searchParams.get('redirect_uri')).toBe(
            'http://localhost:8080/callback',
        );
        expect(url.searchParams.get('scope')).toBe('trading');
    });

    it('exchanges an authorization code for a token', async () => {
        const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
            const url = new URL(input.toString());
            expect(url.origin + url.pathname).toBe(
                'https://openapi.ctrader.com/apps/token',
            );
            expect(url.searchParams.get('grant_type')).toBe(
                'authorization_code',
            );
            expect(url.searchParams.get('code')).toBe('auth-code');
            expect(url.searchParams.get('redirect_uri')).toBe(
                'http://localhost:8080/callback',
            );
            expect(url.searchParams.get('client_id')).toBe('client-id');
            expect(url.searchParams.get('client_secret')).toBe('client-secret');

            return new Response(
                JSON.stringify({
                    accessToken: 'access-token',
                    refreshToken: 'refresh-token',
                    tokenType: 'bearer',
                    expiresIn: 2_628_000,
                }),
                { status: 200 },
            );
        });
        vi.stubGlobal('fetch', fetchMock);

        const token = await client.exchangeAuthorizationCode({
            code: 'auth-code',
            redirectUri: 'http://localhost:8080/callback',
        });

        expect(token).toEqual({
            accessToken: 'access-token',
            refreshToken: 'refresh-token',
            tokenType: 'bearer',
            expiresIn: 2_628_000,
        });
        expect(fetchMock).toHaveBeenCalledOnce();
    });

    it('refreshes an access token', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async (input: RequestInfo | URL) => {
                const url = new URL(input.toString());
                expect(url.searchParams.get('grant_type')).toBe(
                    'refresh_token',
                );
                expect(url.searchParams.get('refresh_token')).toBe(
                    'old-refresh-token',
                );

                return new Response(
                    JSON.stringify({
                        accessToken: 'new-access-token',
                        refreshToken: 'new-refresh-token',
                        tokenType: 'bearer',
                        expiresIn: 2_628_000,
                    }),
                    { status: 200 },
                );
            }),
        );

        const token = await client.refreshAccessToken({
            refreshToken: 'old-refresh-token',
        });

        expect(token.accessToken).toBe('new-access-token');
    });

    it('throws SpotwareOAuthError when the server reports an error', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(
                async () =>
                    new Response(
                        JSON.stringify({
                            errorCode: 'INVALID_GRANT',
                            description: 'code expired',
                        }),
                        { status: 400 },
                    ),
            ),
        );

        await expect(
            client.exchangeAuthorizationCode({
                code: 'expired',
                redirectUri: 'http://localhost:8080/callback',
            }),
        ).rejects.toThrow(SpotwareOAuthError);
    });

    it('throws SpotwareOAuthError when the network request itself fails', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => {
                throw new Error('getaddrinfo ENOTFOUND');
            }),
        );

        await expect(
            client.refreshAccessToken({ refreshToken: 'token' }),
        ).rejects.toThrow(SpotwareOAuthError);
    });
});
