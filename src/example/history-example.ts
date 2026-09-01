import { SpotwareHistory, MAX_CASH_FLOW_RANGE_MS } from '../history';
import { createAuthenticatedClient } from './shared/create-authenticated-client';

const DAY_MS = 24 * 60 * 60 * 1000;

async function main(): Promise<void> {
    const client = await createAuthenticatedClient();
    const history = new SpotwareHistory(client);

    const days = Number(process.argv[2] ?? 7);
    const toTimestamp = Date.now();
    const fromTimestamp = toTimestamp - days * DAY_MS;

    const deals = await history.getDeals({
        fromTimestamp,
        toTimestamp,
        maxRows: 20
    });
    console.log(`\nDeals in the last ${days} day(s): ${deals.deals.length}${deals.hasMore ? ' (more available — narrow the range)' : ''}`);
    console.table(
        deals.deals.map((deal) => ({
            dealId: deal.dealId,
            positionId: deal.positionId,
            symbolId: deal.symbolId,
            side: deal.tradeSide,
            volume: deal.volume / 100,
            executionPrice: deal.executionPrice,
            executedAt: new Date(deal.executionTimestamp).toISOString()
        }))
    );

    const orders = await history.getOrders({ fromTimestamp, toTimestamp });
    console.log(`\nOrders in the same window: ${orders.orders.length}${orders.hasMore ? ' (more available)' : ''}`);

    // Every deal on one position — the fills that opened it, added to it, and closed it.
    const firstPositionId = deals.deals[0]?.positionId;
    if (firstPositionId) {
        const positionDeals = await history.getDealsByPositionId({
            positionId: firstPositionId
        });
        console.log(`\nDeals belonging to position ${firstPositionId}: ${positionDeals.deals.length}`);
    }

    // cTrader caps this one at a week per request, so a longer history means walking the range
    // a week at a time rather than asking for it all at once.
    const cashFlowFrom = Math.max(fromTimestamp, toTimestamp - MAX_CASH_FLOW_RANGE_MS);
    const cashFlow = await history.getCashFlow({
        fromTimestamp: cashFlowFrom,
        toTimestamp
    });
    console.log(`\nDeposits/withdrawals in the last week: ${cashFlow.length}`);
    console.table(
        cashFlow.map((entry) => ({
            type: entry.operationType,
            delta: entry.delta,
            balance: entry.balance,
            at: new Date(entry.changeBalanceTimestamp).toISOString()
        }))
    );

    await client.disconnect();
}

main().catch((error: Error) => {
    console.error(error);
    process.exit(1);
});
