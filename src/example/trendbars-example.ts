import { SpotwareMarketData } from '../market-data';
import { ProtoOATrendbarPeriod } from '../types';
import { createAuthenticatedClient } from './shared/create-authenticated-client';

async function main(): Promise<void> {
    const client = await createAuthenticatedClient();
    const marketData = new SpotwareMarketData(client);

    const symbolName = process.argv[2] ?? 'EURUSD';
    const symbol = await marketData.symbols.findByName(symbolName);
    if (!symbol) {
        throw new Error(`Symbol "${symbolName}" was not found for this account`);
    }

    const bars = await marketData.getTrendbars({
        symbolId: symbol.symbolId,
        period: ProtoOATrendbarPeriod.H1,
        fromTimestamp: Date.now() - 24 * 60 * 60 * 1000,
        toTimestamp: Date.now()
    });

    console.log(`\nFetched ${bars.length} H1 bars for ${symbol.symbolName}:`);
    console.table(bars.map((bar) => ({ ...bar, timestamp: bar.timestamp ? new Date(bar.timestamp).toISOString() : undefined })));

    await client.disconnect();
}

main().catch((error: Error) => {
    console.error(error);
    process.exit(1);
});
