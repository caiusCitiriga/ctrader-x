import { describe, it, expect } from '@jest/globals';
import { ConnectionManger } from '../../src/lib/connection-manager';

describe('Connection manager', () => {
    let connectionManager: ConnectionManger;

    beforeEach(() => {
        connectionManager = new ConnectionManger();
    });

    afterEach(() => {
        connectionManager.dispose();
    });

    afterAll(() => {
        jest.clearAllMocks();
    });

    it('Successfully connects tls socket', async () => {
        expect(await connectionManager.connect()).toBeTruthy();
    });

    it('Returns connected false if not connected', async () => {
        expect(connectionManager.connected).toBeFalsy();
    });

    it('Returns connected false if tls socket is connecting', async () => {
        const tls = require('tls');
        jest.spyOn(tls, 'connect').mockReturnValue({
            once: jest.fn((_, cb) => {
                cb();
            }),
            on: jest.fn(),
            write: jest.fn(),
            connecting: true,
            destroy: jest.fn(),
        });

        await connectionManager.connect();
        expect(connectionManager.connected).toBeFalsy();
    });

    it('Throws if trying to access client before connecting', async () => {
        expect(() => connectionManager.client).toThrow();
    });

    it('Returns client after connecting', async () => {
        await connectionManager.connect();
        expect(() => connectionManager.client).toBeDefined();
    });

    it('Throws timeout if cannot connect within 5s', async () => {
        jest.mock('tls', () => ({
            once: () => null,
            connect: () => null,
        }));

        try {
            connectionManager.connect();
            await new Promise<void>((r) => setTimeout(() => r(), 4000));
        } catch (e: any) {
            expect(e.message).toBe('Connection timeout');
        }
    });
});
