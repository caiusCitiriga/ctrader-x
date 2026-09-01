import { describe, expect, it } from 'vitest';

import { encodeFrame, FrameDecoder } from '../../src/transport/frame-codec';

describe('frame-codec', () => {
    it('round-trips a single frame delivered in one chunk', () => {
        const payload = Buffer.from('hello');
        const decoder = new FrameDecoder();

        const frames = decoder.push(encodeFrame(payload));

        expect(frames).toHaveLength(1);
        expect(frames[0]).toEqual(payload);
    });

    it('extracts multiple frames delivered in a single chunk', () => {
        const first = Buffer.from('first');
        const second = Buffer.from('second-payload');
        const decoder = new FrameDecoder();

        const frames = decoder.push(
            Buffer.concat([encodeFrame(first), encodeFrame(second)]),
        );

        expect(frames).toHaveLength(2);
        expect(frames[0]).toEqual(first);
        expect(frames[1]).toEqual(second);
    });

    it('reassembles a frame split across arbitrary chunk boundaries, byte by byte', () => {
        const payload = Buffer.from(
            'a not-so-short payload spanning many chunks',
        );
        const encoded = encodeFrame(payload);
        const decoder = new FrameDecoder();

        const collected: Buffer[] = [];
        for (const byte of encoded) {
            collected.push(...decoder.push(Buffer.from([byte])));
        }

        expect(collected).toHaveLength(1);
        expect(collected[0]).toEqual(payload);
    });

    it('holds a partial frame until the rest arrives, then yields it', () => {
        const payload = Buffer.from('buffered payload');
        const encoded = encodeFrame(payload);
        const decoder = new FrameDecoder();

        const firstHalf = decoder.push(encoded.subarray(0, 3));
        expect(firstHalf).toHaveLength(0);

        const rest = decoder.push(encoded.subarray(3));
        expect(rest).toHaveLength(1);
        expect(rest[0]).toEqual(payload);
    });

    it('throws when a declared frame length exceeds the safety limit', () => {
        const corruptedLengthPrefix = Buffer.alloc(4);
        corruptedLengthPrefix.writeUInt32BE(64 * 1024 * 1024);
        const decoder = new FrameDecoder();

        expect(() => decoder.push(corruptedLengthPrefix)).toThrow(/exceeds/);
    });
});
