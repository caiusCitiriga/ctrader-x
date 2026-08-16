import type { SpotwareClient } from '../client';
import { SPOTWARE_VOLUME_SCALE } from '../shared/spotware-scale';
import {
    ProtoOAAmendOrderReq,
    ProtoOACancelOrderReq,
    ProtoOAClosePositionReq,
    ProtoOAExecutionEvent,
    ProtoOANewOrderReq,
    ProtoOAOrder,
    ProtoOAOrderType,
    ProtoOAPayloadType,
    ProtoOAPosition,
    ProtoOAReconcileReq,
    ProtoOAReconcileRes,
    ProtoOATimeInForce,
    ProtoOATradeSide
} from '../types';

export interface IPlaceMarketOrderParams {
    symbolId: number;
    tradeSide: ProtoOATradeSide;
    /** In units (e.g. 1000 for 1000 units) — converted internally, not the wire's cents form. */
    volume: number;
    /** Absolute price (e.g. 1.23456), not scaled. */
    stopLoss?: number;
    /** Absolute price (e.g. 1.23456), not scaled. */
    takeProfit?: number;
    comment?: string;
    label?: string;
}

export interface IPlaceLimitOrderParams extends IPlaceMarketOrderParams {
    /** Absolute price (e.g. 1.23456), not scaled. */
    limitPrice: number;
    timeInForce?: ProtoOATimeInForce;
    expirationTimestamp?: number;
}

export interface IAmendOrderParams {
    orderId: number;
    /** In units — converted internally, not the wire's cents form. */
    volume?: number;
    limitPrice?: number;
    stopPrice?: number;
    stopLoss?: number;
    takeProfit?: number;
    expirationTimestamp?: number;
}

export interface IClosePositionParams {
    positionId: number;
    /** In units — converted internally, not the wire's cents form. */
    volume: number;
}

export interface IOpenPositionsAndOrders {
    positions: ProtoOAPosition[];
    orders: ProtoOAOrder[];
}

/**
 * Places/modifies/cancels orders and closes positions, via `client`. Knows nothing about
 * market data streaming. Order mutations have no dedicated response message: the outcome
 * arrives as a ProtoOAExecutionEvent on success, or rejects via ProtoOAOrderErrorEvent (which
 * `client` already treats as an error) on failure. Volume here is in units, not the wire's
 * cents representation; prices other than relative SL/TP stay plain decimals, matching the
 * protocol's own convention (confirmed against Spotware's official SDK, not assumed).
 */
export class SpotwareTrading {
    constructor(private readonly client: SpotwareClient) {}

    placeMarketOrder(params: IPlaceMarketOrderParams): Promise<ProtoOAExecutionEvent> {
        return this.placeOrder({ ...params, orderType: ProtoOAOrderType.MARKET });
    }

    placeLimitOrder(params: IPlaceLimitOrderParams): Promise<ProtoOAExecutionEvent> {
        return this.placeOrder({ ...params, orderType: ProtoOAOrderType.LIMIT });
    }

    async amendOrder(params: IAmendOrderParams): Promise<ProtoOAExecutionEvent> {
        const request = ProtoOAAmendOrderReq.fromPartial({
            ctidTraderAccountId: this.client.ctidTraderAccountId,
            orderId: params.orderId,
            volume: params.volume === undefined ? undefined : params.volume * SPOTWARE_VOLUME_SCALE,
            limitPrice: params.limitPrice,
            stopPrice: params.stopPrice,
            stopLoss: params.stopLoss,
            takeProfit: params.takeProfit,
            expirationTimestamp: params.expirationTimestamp
        });

        const response = await this.client.send(ProtoOAPayloadType.PROTO_OA_AMEND_ORDER_REQ, ProtoOAAmendOrderReq.encode(request).finish());

        return ProtoOAExecutionEvent.decode(response.payload ?? new Uint8Array());
    }

    async cancelOrder(orderId: number): Promise<ProtoOAExecutionEvent> {
        const request = ProtoOACancelOrderReq.fromPartial({ ctidTraderAccountId: this.client.ctidTraderAccountId, orderId });
        const response = await this.client.send(ProtoOAPayloadType.PROTO_OA_CANCEL_ORDER_REQ, ProtoOACancelOrderReq.encode(request).finish());

        return ProtoOAExecutionEvent.decode(response.payload ?? new Uint8Array());
    }

    async closePosition(params: IClosePositionParams): Promise<ProtoOAExecutionEvent> {
        const request = ProtoOAClosePositionReq.fromPartial({
            ctidTraderAccountId: this.client.ctidTraderAccountId,
            positionId: params.positionId,
            volume: params.volume * SPOTWARE_VOLUME_SCALE
        });

        const response = await this.client.send(
            ProtoOAPayloadType.PROTO_OA_CLOSE_POSITION_REQ,
            ProtoOAClosePositionReq.encode(request).finish()
        );

        return ProtoOAExecutionEvent.decode(response.payload ?? new Uint8Array());
    }

    async getOpenPositionsAndOrders(): Promise<IOpenPositionsAndOrders> {
        const request = ProtoOAReconcileReq.fromPartial({ ctidTraderAccountId: this.client.ctidTraderAccountId });
        const response = await this.client.send(ProtoOAPayloadType.PROTO_OA_RECONCILE_REQ, ProtoOAReconcileReq.encode(request).finish());
        const reconcile = ProtoOAReconcileRes.decode(response.payload ?? new Uint8Array());

        return { positions: reconcile.position, orders: reconcile.order };
    }

    private async placeOrder(
        params: (IPlaceMarketOrderParams | IPlaceLimitOrderParams) & { orderType: ProtoOAOrderType }
    ): Promise<ProtoOAExecutionEvent> {
        const request = ProtoOANewOrderReq.fromPartial({
            ctidTraderAccountId: this.client.ctidTraderAccountId,
            symbolId: params.symbolId,
            orderType: params.orderType,
            tradeSide: params.tradeSide,
            volume: params.volume * SPOTWARE_VOLUME_SCALE,
            limitPrice: 'limitPrice' in params ? params.limitPrice : undefined,
            timeInForce: 'timeInForce' in params ? params.timeInForce : undefined,
            expirationTimestamp: 'expirationTimestamp' in params ? params.expirationTimestamp : undefined,
            stopLoss: params.stopLoss,
            takeProfit: params.takeProfit,
            comment: params.comment,
            label: params.label
        });

        const response = await this.client.send(ProtoOAPayloadType.PROTO_OA_NEW_ORDER_REQ, encodeNewOrderReq(request));

        return ProtoOAExecutionEvent.decode(response.payload ?? new Uint8Array());
    }
}

// ts-proto skips a required field on the wire whenever its value equals the field's implicit
// proto2 default — for an enum with no explicit `[default = ...]` annotation, that's always its
// first declared member. orderType and tradeSide have no such annotation, so MARKET (1) and BUY
// (1) — the two most common choices — get silently dropped, and cTrader's server rejects the
// message as missing them. Confirmed this isn't fixable via ts-proto's codegen flags
// (disableProto2DefaultValues only affects fields with an explicit default). Field order doesn't
// matter on the wire, so appending the dropped ones after the normal encode is a safe, minimal
// fix that doesn't require hand-editing generated code.
function encodeNewOrderReq(request: ProtoOANewOrderReq): Uint8Array {
    const writer = ProtoOANewOrderReq.encode(request);

    if (request.orderType === ProtoOAOrderType.MARKET) {
        writer.uint32(32).int32(request.orderType);
    }
    if (request.tradeSide === ProtoOATradeSide.BUY) {
        writer.uint32(40).int32(request.tradeSide);
    }

    return writer.finish();
}
