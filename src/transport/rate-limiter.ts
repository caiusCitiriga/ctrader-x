export class RateLimiter {
    private readonly queue: Array<() => void> = [];
    private lastRunAt = 0;
    private timer: NodeJS.Timeout | undefined;

    constructor(private readonly intervalMs: number) {}

    schedule(): Promise<void> {
        return new Promise((resolve) => {
            const elapsedSinceLastRun = Date.now() - this.lastRunAt;

            if (!this.timer && elapsedSinceLastRun >= this.intervalMs) {
                this.lastRunAt = Date.now();
                resolve();
                return;
            }

            this.queue.push(resolve);
            this.ensureTimerRunning();
        });
    }

    dispose(): void {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = undefined;
        }
        this.queue.length = 0;
    }

    private ensureTimerRunning(): void {
        if (this.timer) {
            return;
        }

        this.timer = setInterval(() => {
            const next = this.queue.shift();
            if (!next) {
                clearInterval(this.timer);
                this.timer = undefined;
                return;
            }

            this.lastRunAt = Date.now();
            next();
        }, this.intervalMs);
    }
}
