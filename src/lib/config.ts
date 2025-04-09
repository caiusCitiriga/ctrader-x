import 'dotenv/config';

export class Config {
    static get SPOTWARE__CTID_TRADER_ACCOUNT_ID() {
        this.ensureConfigExistenceOrThrow('SPOTWARE__CTID_TRADER_ACCOUNT_ID');
        const value = this.getConfig('SPOTWARE__CTID_TRADER_ACCOUNT_ID');
        if (!!value && !isNaN(+value)) return +value;
        throw new Error(
            `Invalid SPOTWARE__CTID_TRADER_ACCOUNT_ID. Should be a number`
        );
    }

    static get SPOTWARE__ACCESS_TOKEN() {
        this.ensureConfigExistenceOrThrow('SPOTWARE__ACCESS_TOKEN');
        return this.getConfig('SPOTWARE__ACCESS_TOKEN');
    }

    static get SPOTWARE__CLIENT_SECRET() {
        this.ensureConfigExistenceOrThrow('SPOTWARE__CLIENT_SECRET');
        return this.getConfig('SPOTWARE__CLIENT_SECRET');
    }

    static get SPOTWARE__CLIENT_ID() {
        this.ensureConfigExistenceOrThrow('SPOTWARE__CLIENT_ID');
        return this.getConfig('SPOTWARE__CLIENT_ID');
    }

    static get DEBUG_LOGS() {
        this.ensureConfigExistenceOrThrow('DEBUG_LOGS');
        return this.getConfig('DEBUG_LOGS') === 'true';
    }

    private static ensureConfigExistenceOrThrow(config: string): void {
        if (!process.env[config])
            throw new Error(`Missing env config ${config}. Please provide it`);
    }

    private static getConfig(config: string): string {
        return process.env[config]!;
    }
}
