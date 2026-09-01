import { ProtoOAPayloadType } from '../types';
import { RateLimiter } from './rate-limiter';

// Spotware limits these to 5/sec and everything else to 50/sec.
// Intervals are set just above the theoretical minimum to stay clear of the limit.
// https://connect.spotware.com/docs/frequently-asked-questions
const FIVE_PER_SECOND_INTERVAL_MS = 210;
const FIFTY_PER_SECOND_INTERVAL_MS = 21;

const FIVE_PER_SECOND_PAYLOAD_TYPES = new Set<ProtoOAPayloadType>([
    ProtoOAPayloadType.PROTO_OA_GET_TRENDBARS_REQ,
    ProtoOAPayloadType.PROTO_OA_GET_TICKDATA_REQ,
    ProtoOAPayloadType.PROTO_OA_DEAL_LIST_REQ,
]);

export class SpotwareRateLimiter {
    private readonly fivePerSecond = new RateLimiter(
        FIVE_PER_SECOND_INTERVAL_MS,
    );
    private readonly fiftyPerSecond = new RateLimiter(
        FIFTY_PER_SECOND_INTERVAL_MS,
    );

    async throttle(payloadType: ProtoOAPayloadType): Promise<void> {
        const limiter = FIVE_PER_SECOND_PAYLOAD_TYPES.has(payloadType)
            ? this.fivePerSecond
            : this.fiftyPerSecond;
        await limiter.schedule();
    }

    dispose(): void {
        this.fivePerSecond.dispose();
        this.fiftyPerSecond.dispose();
    }
}
