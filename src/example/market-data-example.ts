import { SpotwareMarketData } from '../market-data';
import { SPOTWARE_VOLUME_SCALE } from '../shared/spotware-scale';
import { createAuthenticatedClient } from './shared/create-authenticated-client';

const SYMBOL_NAME = process.argv[2] ?? 'EURUSD';
const LISTEN_DURATION_MS = 60_000;

async function main(): Promise<void> {
    const client = await createAuthenticatedClient();
    const marketData = new SpotwareMarketData(client);
    marketData.on('error', (error) => console.error('Market data error:', error.message));
    marketData.on('price', (update) => {
        const bid = update.bid?.toFixed(5) ?? '-';
        const ask = update.ask?.toFixed(5) ?? '-';
        console.log(`[${update.symbolId}] bid=${bid} ask=${ask}`);
    });

    const symbol = await marketData.symbols.findByName(SYMBOL_NAME);
    if (!symbol) {
        throw new Error(`Symbol "${SYMBOL_NAME}" was not found for this account`);
    }

    // getFullSymbol() is the full per-symbol spec — findByName()/getAll() only return the
    // light list, which doesn't carry the fields you need to validate a volume or round a
    // price correctly, since those are defined per symbol by the broker, not a fixed ratio.
    const fullSymbol = await marketData.symbols.getFullSymbol(symbol.symbolId);
    if (fullSymbol) {
        console.log(`\n${symbol.symbolName} trading constraints:`);
        console.table({
            digits: fullSymbol.digits,
            pipPosition: fullSymbol.pipPosition,
            lotSizeUnits: (fullSymbol.lotSize ?? 0) / SPOTWARE_VOLUME_SCALE,
            minVolumeUnits: (fullSymbol.minVolume ?? 0) / SPOTWARE_VOLUME_SCALE,
            maxVolumeUnits: (fullSymbol.maxVolume ?? 0) / SPOTWARE_VOLUME_SCALE,
            stepVolumeUnits: (fullSymbol.stepVolume ?? 0) / SPOTWARE_VOLUME_SCALE
        });
    }

    console.log(`\nSubscribing to ${symbol.symbolName} (symbolId ${symbol.symbolId})...`);
    await marketData.subscribe(symbol.symbolId);

    console.log(`Listening for price updates for ${LISTEN_DURATION_MS / 1000}s (Ctrl+C to stop earlier)...\n`);
    await new Promise((resolve) => setTimeout(resolve, LISTEN_DURATION_MS));

    console.log(`\nUnsubscribing and disconnecting...`);
    await marketData.unsubscribe(symbol.symbolId);
    await client.disconnect();
}

main().catch((error: Error) => {
    console.error(error);
    process.exit(1);
});
