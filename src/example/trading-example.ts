import { SpotwareMarketData, type ISpotwarePriceUpdate } from '../market-data';
import { SpotwareTrading } from '../trading';
import { ProtoOATradeSide } from '../types';
import { createAuthenticatedClient } from './shared/create-authenticated-client';

const SYMBOL_NAME = process.argv[2] ?? 'EURUSD';
// Small enough to be a plausible minimum size on a demo account, without assuming a specific
// broker's actual minimum — if it's rejected, the OrderErrorEvent rejection prints clearly.
const ORDER_VOLUME_UNITS = 1_000;

function waitForBid(marketData: SpotwareMarketData, symbolId: number): Promise<number> {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            marketData.off('price', onPrice);
            reject(new Error('Timed out waiting for a price update'));
        }, 10_000);

        const onPrice = (update: ISpotwarePriceUpdate) => {
            if (update.symbolId !== symbolId || update.bid === undefined) {
                return;
            }
            clearTimeout(timeout);
            marketData.off('price', onPrice);
            resolve(update.bid);
        };

        marketData.on('price', onPrice);
    });
}

async function main(): Promise<void> {
    const client = await createAuthenticatedClient();
    const trading = new SpotwareTrading(client);
    // Only need the symbol catalog here, not price streaming for its own sake — this is the
    // same public SpotwareSymbolCatalog a consumer could use standalone.
    const marketData = new SpotwareMarketData(client);

    console.log('\nOpen positions:');
    const { positions, orders } = await trading.getOpenPositionsAndOrders();
    console.table(
        positions.map((position) => ({
            positionId: position.positionId,
            symbolId: position.tradeData?.symbolId,
            side: position.tradeData?.tradeSide,
            volume: position.tradeData?.volume
        }))
    );
    console.log('Pending orders:');
    console.table(orders.map((order) => ({ orderId: order.orderId, status: order.orderStatus, type: order.orderType })));

    const symbol = await marketData.symbols.findByName(SYMBOL_NAME);
    if (!symbol) {
        throw new Error(`Symbol "${SYMBOL_NAME}" was not found for this account`);
    }

    console.log(`\nFetching a reference price for ${symbol.symbolName}...`);
    const bidPromise = waitForBid(marketData, symbol.symbolId);
    await marketData.subscribe(symbol.symbolId);
    const bid = await bidPromise;
    await marketData.unsubscribe(symbol.symbolId);

    // 10% below the current bid: a BUY limit there is virtually guaranteed to stay pending
    // rather than fill, so placing and cancelling it is safe to run against a real demo account.
    const limitPrice = Number((bid * 0.9).toFixed(5));
    console.log(`Current bid: ${bid}. Placing a BUY limit order at ${limitPrice} (won't fill)...`);

    const execution = await trading.placeLimitOrder({
        symbolId: symbol.symbolId,
        tradeSide: ProtoOATradeSide.BUY,
        volume: ORDER_VOLUME_UNITS,
        limitPrice,
        comment: 'ctrader-x trading example — safe to cancel'
    });
    const orderId = execution.order?.orderId;
    console.log(`Order placed (executionType=${execution.executionType}), orderId=${orderId}`);

    if (orderId === undefined) {
        throw new Error('No orderId was returned for the placed order');
    }

    console.log('Cancelling it...');
    const cancellation = await trading.cancelOrder(orderId);
    console.log(`Cancelled (executionType=${cancellation.executionType}).`);

    await client.disconnect();
}

main().catch((error: Error) => {
    console.error(error);
    process.exit(1);
});
