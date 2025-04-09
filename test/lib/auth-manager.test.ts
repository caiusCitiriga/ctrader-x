import { describe, it, expect } from '@jest/globals';
import { AuthManager } from '../../src/lib/auth-manager';
import { ConnectionManger } from '../../src/lib/connection-manager';
import { Config } from '../../src/lib/config';
import { env } from 'process';

describe('Auth manager', () => {
    let authManger: AuthManager;
    let connectionManager: ConnectionManger;

    beforeAll(() => {
        env.DEBUG_LOGS = 'false';
    });

    beforeEach(async () => {
        connectionManager = new ConnectionManger();
        await connectionManager.connect();

        authManger = new AuthManager(connectionManager.client);
    });

    afterEach(() => {
        connectionManager.dispose();
    });

    afterAll(() => {
        jest.clearAllMocks();
    });

    it('Successfully authenticates application and account', async () => {
        expect(
            await authManger.authenticate({
                clientId: Config.SPOTWARE__CLIENT_ID!,
                accessToken: Config.SPOTWARE__ACCESS_TOKEN!,
                clientSecret: Config.SPOTWARE__CLIENT_SECRET!,
                ctidTraderAccountId: Config.SPOTWARE__CTID_TRADER_ACCOUNT_ID!,
            })
        ).toBeTruthy();
        expect(authManger.isAuthenticated).toBeTruthy();
        expect(authManger.ctidTraderAccountId).toBe(
            +process.env.SPOTWARE__CTID_TRADER_ACCOUNT_ID!
        );
    });

    it('Returns false if app authentication fails', async () => {
        expect(
            await authManger.authenticate({
                clientId: Config.SPOTWARE__CLIENT_ID! + 'some more text',
                accessToken: Config.SPOTWARE__ACCESS_TOKEN!,
                clientSecret: Config.SPOTWARE__CLIENT_SECRET!,
                ctidTraderAccountId: Config.SPOTWARE__CTID_TRADER_ACCOUNT_ID!,
            })
        ).toBeFalsy();
        expect(authManger.isAuthenticated).toBeFalsy();
        expect(authManger.ctidTraderAccountId).toBeUndefined();
    });

    it('Returns false if account authentication fails', async () => {
        expect(
            await authManger.authenticate({
                clientId: Config.SPOTWARE__CLIENT_ID!,
                accessToken: Config.SPOTWARE__ACCESS_TOKEN!,
                clientSecret: Config.SPOTWARE__CLIENT_SECRET!,
                ctidTraderAccountId:
                    Config.SPOTWARE__CTID_TRADER_ACCOUNT_ID! + 1000,
            })
        ).toBeFalsy();
        expect(authManger.isAuthenticated).toBeFalsy();
        expect(authManger.ctidTraderAccountId).toBeUndefined();
    });
});
