import { describe, it, expect } from '@jest/globals';
import { Logger } from '../../src/lib/logger';
import { env } from 'process';

describe('Logger', () => {
    const logger = Logger;

    afterEach(() => {
        jest.clearAllMocks();
    });

    it('logs log messages', async () => {
        const spy = jest.spyOn(console, 'log');
        logger.log('test log');
        expect(spy).toHaveBeenCalledWith(`ℹ️ test log`);
    });

    it('logs error messages', async () => {
        const spy = jest.spyOn(console, 'log');
        logger.error('test error');
        expect(spy).toHaveBeenCalledWith(`❌ test error`);
    });

    it('logs warn messages', async () => {
        const spy = jest.spyOn(console, 'log');
        logger.warn('test warn');
        expect(spy).toHaveBeenCalledWith(`⚠️ test warn`);
    });

    it('logs debug messages', async () => {
        const spy = jest.spyOn(console, 'log');
        logger.debug('test debug');
        expect(spy).toHaveBeenCalledWith(`🐛 test debug`);
    });

    it('does not log debug messages if env DEBUG_LOGS is false', async () => {
        env.DEBUG_LOGS = 'false';
        const spy = jest.spyOn(console, 'log');
        logger.debug('test debug');
        expect(spy).not.toHaveBeenCalled();
    });
});
