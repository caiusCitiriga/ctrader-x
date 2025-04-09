import { exit } from 'process';

import { Logger } from './logger';
import { ConnectionManger } from './connection-manager';
import { AuthManager, AuthParams } from './auth-manager';

export class cTraderX {
    private authManager!: AuthManager;
    private connectionManger!: ConnectionManger;

    async connect(live = false) {
        this.connectionManger = new ConnectionManger(live);
        const connected = await this.connectionManger.connect();
        if (!connected) {
            Logger.error(`Could not establish a connection. Exiting.`);
            exit(1);
        }

        this.authManager = new AuthManager(this.connectionManger.client);
    }

    async authenticate(params: AuthParams) {
        return this.authManager.authenticate(params);
    }
}
