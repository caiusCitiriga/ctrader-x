import { SpotwareMarketData } from '../market-data';
import { ProtoOAQuoteType, ProtoOATrendbarPeriod } from '../types';
import { createAuthenticatedClient } from './shared/create-authenticated-client';

const SYMBOL_NAME = process.argv[2] ?? 'EURUSD';
const LISTEN_DURATION_MS = 60_000;
const HOUR_MS = 60 * 60 * 1000;

async function main(): Promise<void> {
    const client = await createAuthenticatedClient();
    const marketData = new SpotwareMarketData(client);
    marketData.on('error', (error) =>
        console.error('Market data error:', error.message),
    );

    const symbol = await marketData.symbols.findByName(SYMBOL_NAME);
    if (!symbol) {
        throw new Error(
            `Symbol "${SYMBOL_NAME}" was not found for this account`,
        );
    }

    // Historical ticks arrive newest-first and delta-encoded — both the timestamps and the
    // prices are differences against the previous entry. The SDK accumulates them back into
    // absolute values before handing them over.
    console.log(
        `\nFetching the last hour of BID ticks for ${symbol.symbolName}...`,
    );
    const ticks = await marketData.getTickData({
        symbolId: symbol.symbolId,
        type: ProtoOAQuoteType.BID,
        fromTimestamp: Date.now() - HOUR_MS,
        toTimestamp: Date.now(),
    });
    console.log(
        `Got ${ticks.ticks.length} ticks${ticks.hasMore ? ' (more available — narrow the range)' : ''}. Newest five:`,
    );
    console.table(
        ticks.ticks.slice(0, 5).map((tick) => ({
            at: new Date(tick.timestamp).toISOString(),
            price: tick.price,
        })),
    );

    let barCount = 0;
    marketData.on('trendbar', (symbolId, bar) => {
        barCount += 1;
        const at = bar.timestamp ? new Date(bar.timestamp).toISOString() : '-';
        console.log(
            `[bar ${symbolId}] ${at} O=${bar.open} H=${bar.high} L=${bar.low} C=${bar.close} V=${bar.volume}`,
        );
    });

    let depthCount = 0;
    marketData.on('depth', (update) => {
        depthCount += 1;
        const best = update.newQuotes
            .slice(0, 2)
            .map((quote) =>
                quote.bid ? `bid ${quote.bid}` : `ask ${quote.ask}`,
            );
        console.log(
            `[depth ${update.symbolId}] +${update.newQuotes.length} -${update.deletedQuoteIds.length} ${best.join(' ')}`,
        );
    });

    // Live bars ride on spot events rather than arriving as their own message, so this also
    // subscribes to spots for the symbol — you do not have to do it yourself.
    console.log(`\nSubscribing to live M1 bars for ${symbol.symbolName}...`);
    await marketData.subscribeLiveTrendbars({
        symbolId: symbol.symbolId,
        period: ProtoOATrendbarPeriod.M1,
    });

    try {
        await marketData.subscribeDepth(symbol.symbolId);
        console.log('Subscribed to depth of market.');
    } catch (error) {
        console.log(
            'This broker refused depth for this symbol:',
            (error as Error).message,
        );
    }

    console.log(
        `\nListening for ${LISTEN_DURATION_MS / 1000}s (Ctrl+C to stop earlier)...\n`,
    );
    await new Promise((resolve) => setTimeout(resolve, LISTEN_DURATION_MS));

    console.log(
        `\nReceived ${barCount} bar updates and ${depthCount} depth updates.`,
    );

    await marketData.unsubscribeLiveTrendbars({
        symbolId: symbol.symbolId,
        period: ProtoOATrendbarPeriod.M1,
    });
    await marketData.unsubscribeDepth(symbol.symbolId);
    await client.disconnect();
}

main().catch((error: Error) => {
    console.error(error);
    process.exit(1);
});
