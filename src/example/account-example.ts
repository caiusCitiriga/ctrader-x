import { SpotwareAccount } from '../account';
import { SpotwareMarketData } from '../market-data';
import { createAuthenticatedClient } from './shared/create-authenticated-client';

async function main(): Promise<void> {
    const client = await createAuthenticatedClient();
    const account = new SpotwareAccount(client);
    const marketData = new SpotwareMarketData(client);

    const trader = await account.getTrader();
    const balance = await account.getBalance();

    console.log('\nAccount:');
    console.table([
        {
            broker: trader.brokerName,
            balance,
            rawBalance: trader.balance,
            moneyDigits: trader.moneyDigits,
            leverage: `1:${(trader.leverageInCents ?? 0) / 100}`,
        },
    ]);

    // cTrader does not transmit equity: it is the balance plus the net unrealized PnL of every
    // open position, both of which have to be converted with their own response's moneyDigits.
    const unrealized = await account.getPositionsUnrealizedPnL();
    const netUnrealized = unrealized.reduce(
        (total, position) => total + position.netUnrealizedPnL,
        0,
    );
    console.log(
        `\nOpen positions: ${unrealized.length}, net unrealized PnL: ${netUnrealized}`,
    );
    console.log(
        `Equity (balance + net unrealized): ${balance + netUnrealized}`,
    );

    const symbolName = process.argv[2] ?? 'EURUSD';
    const symbol = await marketData.symbols.findByName(symbolName);
    if (symbol) {
        const fullSymbol = await marketData.symbols.getFullSymbol(
            symbol.symbolId,
        );
        // minVolume is in the wire's cents form; the SDK takes volumes in units.
        const minVolumeUnits = (fullSymbol?.minVolume ?? 100_000) / 100;

        console.log(
            `\nMargin required for ${symbolName} at the broker's minimum volume (${minVolumeUnits} units):`,
        );
        console.table(
            await account.getExpectedMargin({
                symbolId: symbol.symbolId,
                volumes: [minVolumeUnits],
            }),
        );
    }

    const assets = await account.getAssets();
    console.log(`\nAssets available to this account: ${assets.length}`);

    const marginCalls = await account.getMarginCalls();
    console.log(`Margin calls configured: ${marginCalls.length}`);

    // These fire on their own, whenever the server decides to send them — no polling involved.
    account.on('traderUpdated', (updated) =>
        console.log('traderUpdated: balance is now', updated.balance),
    );
    account.on('marginChanged', (change) =>
        console.log('marginChanged:', change),
    );
    account.on('marginCallTriggered', (marginCall) =>
        console.log('MARGIN CALL:', marginCall),
    );
    account.on('tokenInvalidated', (accountIds, reason) =>
        console.log('token revoked for', accountIds, reason),
    );

    console.log(
        '\nListening for account events for 30s (open or close a trade in cTrader to see one)...',
    );
    await new Promise((resolve) => setTimeout(resolve, 30_000));

    await client.disconnect();
}

main().catch((error: Error) => {
    console.error(error);
    process.exit(1);
});
