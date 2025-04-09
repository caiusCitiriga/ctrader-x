import {
    Messages,
    ProtoPayloadType,
    ProtoOAPayloadType,
    SpotwareClientSocket,
} from '@claasahl/spotware-adapter';
import { Logger } from './logger';

export async function sendAndWait<ResponseType>(
    socket: SpotwareClientSocket,
    message: Messages,
    responseTypeMatcher: ProtoPayloadType | ProtoOAPayloadType
) {
    return new Promise<ResponseType>((resolve, reject) => {
        const onData = (res: Messages) => {
            if (res.payloadType === responseTypeMatcher) {
                socket.off('data', onData);
                resolve(res as ResponseType);
            } else if (
                res.payloadType === ProtoPayloadType.ERROR_RES ||
                res.payloadType === ProtoOAPayloadType.PROTO_OA_ERROR_RES
            ) {
                socket.off('data', onData);
                reject(res);
            } else {
                Logger.warn(
                    `Unhandled message: ${ProtoOAPayloadType[res.payloadType]}`
                );
            }
        };

        socket.on('data', onData);

        const writeResult = socket.write(message, (err) => {
            if (err) {
                Logger.error(
                    `Socket write error: ${err.message || err.name}${err.cause ? ' - ' + err.cause : ''}`
                );
                socket.off('data', onData);
                reject(err);
            }
        });

        if (!writeResult) {
            Logger.warn(`Socket write failure: waiting for socket drain`);
            socket.once('drain', () => Logger.debug('Socket drained.'));
        }
    });
}
