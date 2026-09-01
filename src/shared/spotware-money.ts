/**
 * Monetary values (balance, margin, PnL, deposits) are transmitted as integers scaled by a
 * power of ten that the server reports alongside them as `moneyDigits`: with moneyDigits = 8,
 * 10053099944 means 100.53099944.
 *
 * Unlike price and volume the exponent is not fixed, so it must be read from the same response
 * that carried the value — a balance and an unrealized PnL fetched from two different endpoints
 * can legitimately arrive at different scales.
 */
export const DEFAULT_MONEY_DIGITS = 2;

/**
 * Both `undefined` and `0` mean "the server did not specify an exponent", which is not a
 * judgement call: ts-proto decodes an absent optional scalar as 0, and encoding an explicit 0
 * produces byte-identical output to omitting it. The two cases cannot be distinguished on the
 * wire at all, so no broker can express a genuine whole-unit scale this way — which leaves
 * Spotware's documented legacy scale, hundredths, as the only safe reading.
 *
 * Getting this wrong is quiet and expensive: a balance would come back 100x too large, and
 * anything sizing a position from it would be off by the same factor.
 */
export function fromMoneyDigits(value: number, moneyDigits?: number): number {
    return value / 10 ** (moneyDigits || DEFAULT_MONEY_DIGITS);
}
