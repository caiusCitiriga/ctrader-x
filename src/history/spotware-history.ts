import type { SpotwareClient } from '../client';
import { appendRequiredInt64IfDropped } from '../shared/proto-required-field';
import {
    ProtoOACashFlowHistoryListReq,
    ProtoOACashFlowHistoryListRes,
    ProtoOADeal,
    ProtoOADealListByPositionIdReq,
    ProtoOADealListByPositionIdRes,
    ProtoOADealListReq,
    ProtoOADealListRes,
    ProtoOADepositWithdraw,
    ProtoOAOrder,
    ProtoOAOrderListReq,
    ProtoOAOrderListRes,
    ProtoOAPayloadType
} from '../types';

/** A week, in milliseconds — the widest range cTrader accepts for a cash flow query. */
export const MAX_CASH_FLOW_RANGE_MS = 604_800_000;

export interface ITimeRangeParams {
    /** Unix time in milliseconds. Must be >= 0. */
    fromTimestamp: number;
    /** Unix time in milliseconds. Must be <= 2147483646000 (2038-01-19). */
    toTimestamp: number;
}

export interface IGetDealsParams extends ITimeRangeParams {
    /** Caps how many deals come back; the server also applies its own chunk size. */
    maxRows?: number;
}

export interface IGetDealsByPositionIdParams extends Partial<ITimeRangeParams> {
    positionId: number;
}

/**
 * cTrader pages history server-side. `hasMore` means the filter matched more records than the
 * server's chunk size, so the caller should narrow the range (or advance it) and query again
 * rather than assume it has the full set.
 */
export interface IDealHistoryPage {
    deals: ProtoOADeal[];
    hasMore: boolean;
}

export interface IOrderHistoryPage {
    orders: ProtoOAOrder[];
    hasMore: boolean;
}

/**
 * Historical deals, orders and cash flow — the closed record of what happened, as opposed to
 * `SpotwareTrading`'s view of what is currently open. Depends only on `client`.
 *
 * Deals, not orders, are what actually moved money: one order can produce several deals, and
 * realized PnL is carried on the deal's close detail.
 */
export class SpotwareHistory {
    constructor(private readonly client: SpotwareClient) {}

    /** Deals executed in a time range, newest-first, subject to the server's chunk size. */
    async getDeals(params: IGetDealsParams): Promise<IDealHistoryPage> {
        const request = ProtoOADealListReq.fromPartial({
            ctidTraderAccountId: this.client.ctidTraderAccountId,
            fromTimestamp: params.fromTimestamp,
            toTimestamp: params.toTimestamp,
            maxRows: params.maxRows
        });

        const response = await this.client.send(ProtoOAPayloadType.PROTO_OA_DEAL_LIST_REQ, ProtoOADealListReq.encode(request).finish());
        const decoded = ProtoOADealListRes.decode(response.payload ?? new Uint8Array());

        return { deals: decoded.deal, hasMore: decoded.hasMore };
    }

    /** Every deal belonging to one position — the fills that opened, added to, and closed it. */
    async getDealsByPositionId(params: IGetDealsByPositionIdParams): Promise<IDealHistoryPage> {
        const request = ProtoOADealListByPositionIdReq.fromPartial({
            ctidTraderAccountId: this.client.ctidTraderAccountId,
            positionId: params.positionId,
            fromTimestamp: params.fromTimestamp,
            toTimestamp: params.toTimestamp
        });

        const response = await this.client.send(
            ProtoOAPayloadType.PROTO_OA_DEAL_LIST_BY_POSITION_ID_REQ,
            ProtoOADealListByPositionIdReq.encode(request).finish()
        );
        const decoded = ProtoOADealListByPositionIdRes.decode(response.payload ?? new Uint8Array());

        return { deals: decoded.deal, hasMore: decoded.hasMore };
    }

    async getOrders(params: ITimeRangeParams): Promise<IOrderHistoryPage> {
        const request = ProtoOAOrderListReq.fromPartial({
            ctidTraderAccountId: this.client.ctidTraderAccountId,
            fromTimestamp: params.fromTimestamp,
            toTimestamp: params.toTimestamp
        });

        const response = await this.client.send(ProtoOAPayloadType.PROTO_OA_ORDER_LIST_REQ, ProtoOAOrderListReq.encode(request).finish());
        const decoded = ProtoOAOrderListRes.decode(response.payload ?? new Uint8Array());

        return { orders: decoded.order, hasMore: decoded.hasMore };
    }

    /**
     * Deposits and withdrawals. cTrader caps the range at one week, so this rejects a wider one
     * up front rather than letting the server return a less obvious error.
     */
    async getCashFlow(params: ITimeRangeParams): Promise<ProtoOADepositWithdraw[]> {
        if (params.toTimestamp - params.fromTimestamp > MAX_CASH_FLOW_RANGE_MS) {
            throw new RangeError(`Cash flow history covers at most one week per request (${MAX_CASH_FLOW_RANGE_MS} ms)`);
        }

        const request = ProtoOACashFlowHistoryListReq.fromPartial({
            ctidTraderAccountId: this.client.ctidTraderAccountId,
            fromTimestamp: params.fromTimestamp,
            toTimestamp: params.toTimestamp
        });

        const response = await this.client.send(ProtoOAPayloadType.PROTO_OA_CASH_FLOW_HISTORY_LIST_REQ, encodeCashFlowHistoryListReq(request));

        return ProtoOACashFlowHistoryListRes.decode(response.payload ?? new Uint8Array()).depositWithdraw;
    }
}

// fromTimestamp (field 3) and toTimestamp (field 4) are required int64s, so ts-proto drops
// either one set to 0 — and 0 is exactly what you pass for "since the beginning of time".
// See appendRequiredInt64IfDropped.
function encodeCashFlowHistoryListReq(request: ProtoOACashFlowHistoryListReq): Uint8Array {
    const writer = ProtoOACashFlowHistoryListReq.encode(request);
    appendRequiredInt64IfDropped(writer, 3, request.fromTimestamp);
    appendRequiredInt64IfDropped(writer, 4, request.toTimestamp);

    return writer.finish();
}
