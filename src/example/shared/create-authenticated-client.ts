import 'dotenv/config';
import * as fs from 'node:fs/promises';
import * as http from 'node:http';
import * as path from 'node:path';

import {
    SpotwareOAuthClient,
    SpotwareOAuthScope,
    SpotwareSocketAuthenticator,
    type ISpotwareOAuthToken,
} from '../../auth';
import { SpotwareClient } from '../../client';
import { SpotwareHost, SpotwareTransport } from '../../transport';

const TOKEN_FILE_PATH = path.resolve(
    __dirname,
    '../../../.spotware-token.json',
);
const REDIRECT_PORT = Number(process.env.SPOTWARE__OAUTH_REDIRECT_PORT ?? 3939);
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/callback`;

function requireEnv(name: string): string {
    const value = process.env[name];
    if (!value) {
        throw new Error(`Missing required environment variable "${name}"`);
    }

    return value;
}

async function readStoredToken(): Promise<ISpotwareOAuthToken | undefined> {
    try {
        return JSON.parse(
            await fs.readFile(TOKEN_FILE_PATH, 'utf8'),
        ) as ISpotwareOAuthToken;
    } catch {
        return undefined;
    }
}

async function writeStoredToken(token: ISpotwareOAuthToken): Promise<void> {
    await fs.writeFile(TOKEN_FILE_PATH, JSON.stringify(token, null, 4), 'utf8');
}

// The authorization code only lives for ~1 minute, so this listener must already be
// up before the user is sent to the browser, not started after.
function waitForAuthorizationCode(port: number): Promise<string> {
    return new Promise((resolve, reject) => {
        const server = http.createServer((request, response) => {
            const url = new URL(request.url ?? '/', `http://localhost:${port}`);
            const code = url.searchParams.get('code');
            const errorParam = url.searchParams.get('error');

            response.writeHead(200, { 'Content-Type': 'text/html' });
            response.end(
                errorParam
                    ? '<p>Authorization failed. You can close this tab.</p>'
                    : '<p>Authorized. You can close this tab.</p>',
            );
            server.close();

            if (errorParam) {
                reject(new Error(`Authorization was denied: ${errorParam}`));
            } else if (code) {
                resolve(code);
            } else {
                reject(new Error('No authorization code was returned'));
            }
        });

        server.listen(port);
    });
}

async function obtainToken(
    oauthClient: SpotwareOAuthClient,
): Promise<ISpotwareOAuthToken> {
    const stored = await readStoredToken();
    if (stored) {
        console.log(
            'Found a stored token, refreshing it (refresh tokens are single-use, so the file gets rewritten)...',
        );
        const refreshed = await oauthClient.refreshAccessToken({
            refreshToken: stored.refreshToken,
        });
        await writeStoredToken(refreshed);

        return refreshed;
    }

    const authorizationUrl = oauthClient.buildAuthorizationUrl({
        redirectUri: REDIRECT_URI,
        scope: SpotwareOAuthScope.TRADING,
    });
    console.log(
        'No stored token found. Open this URL in a browser to authorize the app:\n',
    );
    console.log(authorizationUrl);
    console.log(`\nWaiting for the redirect on ${REDIRECT_URI} ...`);
    console.log(
        `(Make sure "${REDIRECT_URI}" is registered as a redirect URI on this app in the cTrader Open API portal.)`,
    );

    const code = await waitForAuthorizationCode(REDIRECT_PORT);
    const token = await oauthClient.exchangeAuthorizationCode({
        code,
        redirectUri: REDIRECT_URI,
    });
    await writeStoredToken(token);

    return token;
}

// Runs on a short-lived transport just to discover which demo account is linked to this
// token — SpotwareClient itself needs a ctidTraderAccountId up front, so this has to happen
// before it can be constructed.
async function discoverDemoAccountId(
    clientId: string,
    clientSecret: string,
    accessToken: string,
): Promise<number> {
    const transport = new SpotwareTransport({ host: SpotwareHost.DEMO });
    transport.on('error', (error) =>
        console.error('Discovery transport error:', error.message),
    );
    await transport.connect();

    const authenticator = new SpotwareSocketAuthenticator(transport);
    await authenticator.authenticateApplication(clientId, clientSecret);

    console.log('Listing accounts linked to this token...');
    const accounts = await authenticator.listAccounts(accessToken);
    console.table(
        accounts.map((account) => ({
            ctidTraderAccountId: account.ctidTraderAccountId,
            isLive: account.isLive ?? false,
            traderLogin: account.traderLogin,
        })),
    );

    const demoAccount = accounts.find((account) => !account.isLive);
    if (!demoAccount) {
        throw new Error(
            'No demo account is linked to this token. Link a demo account via cTrader before running this script.',
        );
    }

    await transport.disconnect();

    return demoAccount.ctidTraderAccountId;
}

/**
 * Runs the full one-time setup shared by every example script: OAuth (browser flow or cached
 * token refresh), demo account discovery, and a connected, authenticated SpotwareClient. Each
 * example script can then focus purely on the module it's demonstrating.
 */
export async function createAuthenticatedClient(): Promise<SpotwareClient> {
    const clientId = requireEnv('SPOTWARE__CLIENT_ID');
    const clientSecret = requireEnv('SPOTWARE__CLIENT_SECRET');

    const oauthClient = new SpotwareOAuthClient({ clientId, clientSecret });
    const token = await obtainToken(oauthClient);
    const ctidTraderAccountId = await discoverDemoAccountId(
        clientId,
        clientSecret,
        token.accessToken,
    );

    console.log(
        `\nConnecting SpotwareClient for demo account ${ctidTraderAccountId}...`,
    );
    const transport = new SpotwareTransport({ host: SpotwareHost.DEMO });
    const client = new SpotwareClient({
        transport,
        oauthClient,
        clientId,
        clientSecret,
        ctidTraderAccountId,
        token,
    });

    transport.on('reconnecting', (attempt, delayMs) =>
        console.log(`Reconnecting (attempt ${attempt}) in ${delayMs}ms...`),
    );
    client.on('authenticated', () =>
        console.log('Authenticated (application + account).'),
    );
    client.on('tokenRefreshed', (refreshed) => {
        console.log('Access token refreshed.');
        void writeStoredToken(refreshed);
    });
    client.on('error', (error) =>
        console.error('Client error:', error.message),
    );

    await client.connect();

    return client;
}
