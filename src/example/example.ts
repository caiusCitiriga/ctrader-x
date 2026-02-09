import { cTraderX } from '../lib/client';
import { Config } from '../lib/config';

const client = new cTraderX();
client.connect().then(async () => {
    await client.authenticate({
        ctidTraderAccountId: +Config.SPOTWARE__CTID_TRADER_ACCOUNT_ID,
        clientId: Config.SPOTWARE__CLIENT_ID,
        accessToken: Config.SPOTWARE__ACCESS_TOKEN,
        clientSecret: Config.SPOTWARE__CLIENT_SECRET,
    });
});
