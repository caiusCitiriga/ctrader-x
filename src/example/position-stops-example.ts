import { SpotwareMarketData } from '../market-data';
import { SpotwareTrading } from '../trading';
import { ProtoOATradeSide } from '../types';
import { createAuthenticatedClient } from './shared/create-authenticated-client';

const SYMBOL_NAME = process.argv[2] ?? 'EURUSD';
const SETTLE_MS = 2_000;

/**
 * Unlike the other examples, this one really does open a position: moving a stop is only
 * meaningful on a filled trade, and a pending order's stops are amended with `amendOrder`
 * instead. It opens the broker's minimum volume, attaches a stop-loss and take-profit well
 * away from the market, then closes the position again.
 *
 * Run it against a demo account. `createAuthenticatedClient` refuses to connect to a live one.
 */
async function main(): Promise<void> {
    const client = await createAuthenticatedClient();
    const trading = new SpotwareTrading(client);
    const marketData = new SpotwareMarketData(client);

    // The order lifecycle arrives here, not only in the awaited responses: this is what would
    // tell a long-running bot that a stop-loss fired hours after it stopped paying attention.
    trading.on('execution', (event) => console.log(`  [execution] type=${event.executionType} position=${event.position?.positionId ?? '-'}`));
    trading.on('orderError', (event) => console.log(`  [orderError] ${event.errorCode}: ${event.description}`));

    const symbol = await marketData.symbols.findByName(SYMBOL_NAME);
    if (!symbol) {
        throw new Error(`Symbol "${SYMBOL_NAME}" was not found for this account`);
    }

    const fullSymbol = await marketData.symbols.getFullSymbol(symbol.symbolId);
    const digits = fullSymbol?.digits ?? 5;
    const volumeUnits = (fullSymbol?.minVolume ?? 100_000) / 100;

    console.log(`\nOpening a ${volumeUnits}-unit BUY on ${symbol.symbolName}...`);
    const opened = await trading.placeMarketOrder({
        symbolId: symbol.symbolId,
        tradeSide: ProtoOATradeSide.BUY,
        volume: volumeUnits,
        label: 'ctrader-x position-stops example'
    });

    // The fill's own execution event does not carry a usable entry price, so the position is
    // read back from the account instead of trusting the response for it.
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
    const { positions } = await trading.getOpenPositionsAndOrders();
    const position = positions.find((candidate) => candidate.positionId === opened.position?.positionId) ?? positions[0];

    if (!position?.price) {
        throw new Error('The position was opened but carries no entry price to work from');
    }

    console.log(`Filled at ${position.price} (positionId ${position.positionId}).`);

    const stopLoss = Number((position.price * 0.97).toFixed(digits));
    const takeProfit = Number((position.price * 1.03).toFixed(digits));

    console.log(`Attaching stop-loss ${stopLoss} and take-profit ${takeProfit}...`);
    const amended = await trading.amendPositionStopLossTakeProfit({
        positionId: position.positionId,
        stopLoss,
        takeProfit
    });
    console.log(`Position now reports SL=${amended.position?.stopLoss} TP=${amended.position?.takeProfit}`);

    console.log('Closing the position...');
    await trading.closePosition({
        positionId: position.positionId,
        volume: volumeUnits
    });

    // Reconcile lags a close by a moment, so an immediate query can still show the position.
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
    const after = await trading.getOpenPositionsAndOrders();
    console.log(`\nOpen positions remaining: ${after.positions.length}`);

    await client.disconnect();
}

main().catch((error: Error) => {
    console.error(error);
    process.exit(1);
});
