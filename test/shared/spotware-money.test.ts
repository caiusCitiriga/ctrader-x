import { describe, expect, it } from 'vitest';

import {
    DEFAULT_MONEY_DIGITS,
    fromMoneyDigits,
} from '../../src/shared/spotware-money';

describe('fromMoneyDigits', () => {
    it('applies the exponent the server reported', () => {
        // The example straight out of the .proto's own field comment.
        expect(fromMoneyDigits(10_053_099_944, 8)).toBeCloseTo(100.53099944, 8);
    });

    it('falls back to hundredths when the server omits the exponent', () => {
        expect(fromMoneyDigits(10_053)).toBeCloseTo(100.53, 2);
        expect(DEFAULT_MONEY_DIGITS).toBe(2);
    });

    it('treats an explicit zero exponent as unspecified', () => {
        // Not a preference: ts-proto decodes an absent optional scalar as 0, and an explicit 0
        // encodes to the same bytes as omitting the field, so the two are indistinguishable on
        // the wire. Reading 0 literally would silently report balances 100x too large.
        expect(fromMoneyDigits(10_053, 0)).toBeCloseTo(100.53, 2);
    });

    it('keeps negative amounts negative', () => {
        expect(fromMoneyDigits(-2_575, 2)).toBeCloseTo(-25.75, 2);
    });
});
