import { env } from 'process';
import { describe, it, expect } from '@jest/globals';
import { sendAndWait } from '../../src/lib/socket-util';
import {
    Messages,
    ProtoOAPayloadType,
    SpotwareClientSocket,
} from '@claasahl/spotware-adapter';

describe('Socket util', () => {
    beforeAll(() => {
        env.DEBUG_LOGS = 'false';
    });

    afterAll(() => {
        jest.clearAllMocks();
    });

    it('Successfully sends and waits for response', async () => {
        const spotwareClientMock: Partial<SpotwareClientSocket> = {
            write: jest.fn((_) => true),
            on: jest.fn((_, cb) => {
                cb(<Messages>{
                    payloadType: ProtoOAPayloadType.PROTO_OA_VERSION_RES,
                    payload: { version: '100' },
                });
                return null!;
            }),
            off: jest.fn(),
        };

        const response = await sendAndWait<{
            payloadType: ProtoOAPayloadType.PROTO_OA_VERSION_RES;
            payload: { version: '100' };
        }>(
            spotwareClientMock as any,
            {
                payload: {},
                payloadType: ProtoOAPayloadType.PROTO_OA_VERSION_REQ,
            },
            ProtoOAPayloadType.PROTO_OA_VERSION_RES,
        );

        expect(response.payload.version).toBe('100');
    });

    it('Successfully handles error response', async () => {
        const spotwareClientMock: Partial<SpotwareClientSocket> = {
            write: jest.fn((_) => true),
            on: jest.fn((_, cb) => {
                cb(<Messages>{
                    payloadType: ProtoOAPayloadType.PROTO_OA_ERROR_RES,
                    payload: { errorCode: '999' },
                });
                return null!;
            }),
            off: jest.fn(),
        };

        try {
            await sendAndWait<{
                payloadType: ProtoOAPayloadType.PROTO_OA_ERROR_RES;
                payload: { errorCode: string };
            }>(
                spotwareClientMock as any,
                {
                    payload: {},
                    payloadType: ProtoOAPayloadType.PROTO_OA_VERSION_REQ,
                },
                ProtoOAPayloadType.PROTO_OA_VERSION_RES,
            );
        } catch (err: any) {
            expect(err.payload.errorCode).toBe('999');
        }
    });

    it('Successfully handles write error', async () => {
        const spotwareClientMock: Partial<SpotwareClientSocket> = {
            write: jest.fn((_, errCb: any) => {
                errCb(new Error('test error'));
                return false;
            }),
            on: jest.fn(),
            off: jest.fn(),
            once: jest.fn(),
        };

        try {
            await sendAndWait(
                spotwareClientMock as any,
                {
                    payload: {},
                    payloadType: ProtoOAPayloadType.PROTO_OA_VERSION_REQ,
                },
                ProtoOAPayloadType.PROTO_OA_VERSION_RES,
            );
        } catch (err: any) {
            expect(err).toBeInstanceOf(Error);
            expect(err.message).toBe('test error');
        }
    });
});
