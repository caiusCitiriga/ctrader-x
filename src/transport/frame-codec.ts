const LENGTH_PREFIX_BYTES = 4;

// cTrader closes the socket well before a legitimate message gets anywhere near this size;
// a length past it means the stream desynced (e.g. a framing bug), not a big message.
const MAX_FRAME_BYTES = 16 * 1024 * 1024;

export function encodeFrame(payload: Uint8Array): Buffer {
    const length = Buffer.alloc(LENGTH_PREFIX_BYTES);
    length.writeUInt32BE(payload.byteLength);

    return Buffer.concat([length, payload]);
}

export class FrameDecoder {
    private buffer: Buffer = Buffer.alloc(0);

    push(chunk: Buffer): Buffer[] {
        this.buffer =
            this.buffer.byteLength === 0
                ? chunk
                : Buffer.concat([this.buffer, chunk]);

        const frames: Buffer[] = [];

        while (this.buffer.byteLength >= LENGTH_PREFIX_BYTES) {
            const frameLength = this.buffer.readUInt32BE(0);
            if (frameLength > MAX_FRAME_BYTES) {
                throw new Error(
                    `Frame length ${frameLength} exceeds the ${MAX_FRAME_BYTES} byte limit; stream is desynced`,
                );
            }

            const frameEnd = LENGTH_PREFIX_BYTES + frameLength;
            if (this.buffer.byteLength < frameEnd) {
                break;
            }

            frames.push(this.buffer.subarray(LENGTH_PREFIX_BYTES, frameEnd));
            this.buffer = this.buffer.subarray(frameEnd);
        }

        return frames;
    }
}
