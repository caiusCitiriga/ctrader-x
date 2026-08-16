export interface IReconnectBackoffOptions {
    baseDelayMs: number;
    maxDelayMs: number;
    factor: number;
}

export const DEFAULT_RECONNECT_BACKOFF_OPTIONS: IReconnectBackoffOptions = {
    baseDelayMs: 500,
    maxDelayMs: 30_000,
    factor: 2
};

/**
 * Equal jitter: half the capped exponential delay is fixed, half is randomized,
 * so retries stay spread out under load instead of synchronizing into bursts.
 */
export function calculateReconnectDelayMs(attempt: number, options: IReconnectBackoffOptions = DEFAULT_RECONNECT_BACKOFF_OPTIONS): number {
    const exponentialDelay = options.baseDelayMs * options.factor ** attempt;
    const cappedDelay = Math.min(exponentialDelay, options.maxDelayMs);
    const guaranteedDelay = cappedDelay / 2;

    return Math.round(guaranteedDelay + Math.random() * guaranteedDelay);
}
