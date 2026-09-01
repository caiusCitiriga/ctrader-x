import { describe, expect, it } from 'vitest';

import {
    calculateReconnectDelayMs,
    type IReconnectBackoffOptions,
} from '../../src/transport/reconnect-backoff';

const options: IReconnectBackoffOptions = {
    baseDelayMs: 500,
    maxDelayMs: 30_000,
    factor: 2,
};

describe('calculateReconnectDelayMs', () => {
    it('grows exponentially with the attempt number, within its jitter band', () => {
        for (const attempt of [0, 1, 2, 3]) {
            const cappedDelay = Math.min(
                options.baseDelayMs * options.factor ** attempt,
                options.maxDelayMs,
            );
            const delay = calculateReconnectDelayMs(attempt, options);

            expect(delay).toBeGreaterThanOrEqual(cappedDelay / 2);
            expect(delay).toBeLessThanOrEqual(cappedDelay);
        }
    });

    it('caps the delay at maxDelayMs for large attempt numbers', () => {
        const delay = calculateReconnectDelayMs(20, options);

        expect(delay).toBeGreaterThanOrEqual(options.maxDelayMs / 2);
        expect(delay).toBeLessThanOrEqual(options.maxDelayMs);
    });
});
