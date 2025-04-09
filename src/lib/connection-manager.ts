import * as tls from 'tls';
import { SpotwareClientSocket } from '@claasahl/spotware-adapter';

import { Logger } from './logger';

export class ConnectionManger {
    private readonly host: string;
    private readonly port = 5035; // ProtoBuf port

    private tlsSocket!: tls.TLSSocket;
    private tlsSocketConnected = false;

    private spotwareClient!: SpotwareClientSocket;

    constructor(live = false) {
        this.host = `${live ? 'live' : 'demo'}.ctraderapi.com`;
    }

    get connected() {
        if (!this.tlsSocket) return false;
        return !this.tlsSocket.connecting && this.tlsSocketConnected;
    }

    get client() {
        if (!this.spotwareClient)
            throw new Error(`Client not initialized. Run "connect" first.`);

        return this.spotwareClient;
    }

    connect() {
        Logger.debug(`Opening connection to "${this.host}:${this.port}"`);
        const timeoutIfNoConnection = (reject: (msg: string) => void) =>
            setTimeout(() => {
                Logger.error(`Connection attempt timed out`);
                reject('Connection timeout');
            }, 3000);

        return new Promise<boolean>((resolve, reject) => {
            this.tlsSocket = tls.connect(this.port, this.host);
            const tout = timeoutIfNoConnection(reject);

            this.tlsSocket.once('secureConnect', async () => {
                Logger.debug(`Socket connection established`);
                this.tlsSocketConnected = true;

                this.spotwareClient = new SpotwareClientSocket(this.tlsSocket);
                Logger.debug(`Spotware client socket created`);

                clearTimeout(tout);
                resolve(true);
            });
        });
    }

    dispose() {
        this.tlsSocket?.destroy();
        this.spotwareClient?.destroy();
    }
}
