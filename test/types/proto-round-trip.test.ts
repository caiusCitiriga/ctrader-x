import { describe, expect, it } from 'vitest';

import {
    ProtoOAApplicationAuthReq,
    ProtoOAPayloadType,
    ProtoOASpotEvent,
    ProtoOATrendbar,
    ProtoOATrendbarPeriod,
} from '../../src/types';

describe('ts-proto codegen round-trip', () => {
    it('preserves required fields and the proto2 default of an omitted optional field', () => {
        const message = ProtoOAApplicationAuthReq.fromPartial({
            clientId: 'client-id',
            clientSecret: 'client-secret',
        });

        const decoded = ProtoOAApplicationAuthReq.decode(
            ProtoOAApplicationAuthReq.encode(message).finish(),
        );

        expect(decoded).toEqual(message);
        expect(decoded.payloadType).toBe(
            ProtoOAPayloadType.PROTO_OA_APPLICATION_AUTH_REQ,
        );
    });

    it('round-trips nested repeated messages', () => {
        const message = ProtoOASpotEvent.fromPartial({
            ctidTraderAccountId: 123,
            symbolId: 1,
            trendbar: [
                { volume: 42, period: ProtoOATrendbarPeriod.H1, low: 100 },
                { volume: 7, period: ProtoOATrendbarPeriod.D1, low: 200 },
            ],
        });

        const decoded = ProtoOASpotEvent.decode(
            ProtoOASpotEvent.encode(message).finish(),
        );

        expect(decoded).toEqual(message);
        expect(decoded.trendbar).toHaveLength(2);
        expect(decoded.trendbar[0]?.period).toBe(ProtoOATrendbarPeriod.H1);
    });

    it('round-trips an explicit enum value that differs from its proto2 default', () => {
        const message = ProtoOATrendbar.fromPartial({
            volume: 1,
            period: ProtoOATrendbarPeriod.H1,
        });

        const decoded = ProtoOATrendbar.decode(
            ProtoOATrendbar.encode(message).finish(),
        );

        expect(decoded.period).toBe(ProtoOATrendbarPeriod.H1);
        expect(decoded.period).not.toBe(ProtoOATrendbarPeriod.M1);
    });

    it('applies the proto2 default enum value when none is provided', () => {
        const message = ProtoOATrendbar.fromPartial({ volume: 1 });

        const decoded = ProtoOATrendbar.decode(
            ProtoOATrendbar.encode(message).finish(),
        );

        expect(decoded.period).toBe(ProtoOATrendbarPeriod.M1);
    });
});
