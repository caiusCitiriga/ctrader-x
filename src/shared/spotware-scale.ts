// Spot prices (bid/ask/sessionClose) and relative stop-loss/take-profit are transmitted as
// fixed-point integers: 123000 means 1.23. Not every price field uses this scale — order-level
// absolute prices (limitPrice, stopPrice, stopLoss, takeProfit) are plain decimals instead, per
// their own doc comments in the generated types. Confirmed against Spotware's own OpenApiPy
// sample, which assigns a plain float to limitPrice with no conversion.
export const SPOTWARE_PRICE_SCALE = 100_000;

// Volumes are transmitted in cents of a unit: 1000 means 10.00 units.
export const SPOTWARE_VOLUME_SCALE = 100;
