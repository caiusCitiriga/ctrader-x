import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RateLimiter } from '../../src/transport/rate-limiter';

describe('RateLimiter', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('runs the first scheduled task immediately', async () => {
        const limiter = new RateLimiter(100);
        const ran = vi.fn();

        void limiter.schedule().then(ran);
        await vi.advanceTimersByTimeAsync(0);

        expect(ran).toHaveBeenCalledOnce();
    });

    it('spaces subsequent tasks by at least the configured interval', async () => {
        const limiter = new RateLimiter(100);
        const timestamps: number[] = [];
        const record = () => timestamps.push(Date.now());

        void limiter.schedule().then(record);
        void limiter.schedule().then(record);
        void limiter.schedule().then(record);

        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(100);
        await vi.advanceTimersByTimeAsync(100);

        expect(timestamps).toHaveLength(3);
        expect(timestamps[1] - timestamps[0]).toBeGreaterThanOrEqual(100);
        expect(timestamps[2] - timestamps[1]).toBeGreaterThanOrEqual(100);
    });
});
