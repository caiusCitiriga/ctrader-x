import { cTraderX } from '../lib/client';

const client = new cTraderX();
client.connect().then(async () => {
    await client.authenticate({
        ctidTraderAccountId: 12345678,
        clientId: 'your-client-id',
        accessToken: 'your-access-token',
        clientSecret: 'your-client-secret',
    });
});
