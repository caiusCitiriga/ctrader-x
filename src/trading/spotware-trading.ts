import type { SpotwareClient } from '../client';
import { appendRequiredEnumIfDropped } from '../shared/proto-required-field';
import { SPOTWARE_VOLUME_SCALE } from '../shared/spotware-scale';
import {
    TypedEventEmitter,
    type EventMap,
} from '../shared/typed-event-emitter';
import {
    ProtoMessage,
    ProtoOAAmendOrderReq,
    ProtoOAAmendPositionSLTPReq,
    ProtoOACancelOrderReq,
    ProtoOAClosePositionReq,
    ProtoOAExecutionEvent,
    ProtoOANewOrderReq,
    ProtoOAOrder,
    ProtoOAOrderErrorEvent,
    ProtoOAOrderTriggerMethod,
    ProtoOAOrderType,
    ProtoOAPayloadType,
    ProtoOAPosition,
    ProtoOAReconcileReq,
    ProtoOAReconcileRes,
    ProtoOATimeInForce,
    ProtoOATradeSide,
    ProtoOATrailingSLChangedEvent,
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
    trailingStopLoss?: boolean;
    /** Only available on French Risk / Guaranteed Stop Loss accounts. */
    guaranteedStopLoss?: boolean;
    stopTriggerMethod?: ProtoOAOrderTriggerMethod;
    comment?: string;
    label?: string;
    /** Your own idempotency/correlation id, echoed back on the resulting order. */
    clientOrderId?: string;
    /** Targets an existing position instead of opening a new one. */
    positionId?: number;
}

export interface IPlaceLimitOrderParams extends IPlaceMarketOrderParams {
    /** Absolute price (e.g. 1.23456), not scaled. */
    limitPrice: number;
    timeInForce?: ProtoOATimeInForce;
    expirationTimestamp?: number;
}

export interface IPlaceStopOrderParams extends IPlaceMarketOrderParams {
    /** Absolute price (e.g. 1.23456), not scaled. */
    stopPrice: number;
    timeInForce?: ProtoOATimeInForce;
    expirationTimestamp?: number;
}

export interface IPlaceStopLimitOrderParams extends IPlaceStopOrderParams {
    /** How far past stopPrice the resulting limit order may fill, in points. */
    slippageInPoints?: number;
}

export interface IPlaceMarketRangeOrderParams extends IPlaceMarketOrderParams {
    /** The price the order was quoted at; the fill is rejected if the market moves beyond the slippage range. */
    baseSlippagePrice: number;
    slippageInPoints: number;
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

export interface IAmendPositionStopLossTakeProfitParams {
    positionId: number;
    /** Absolute price (e.g. 1.23456), not scaled. Omit to leave unchanged. */
    stopLoss?: number;
    /** Absolute price (e.g. 1.23456), not scaled. Omit to leave unchanged. */
    takeProfit?: number;
    trailingStopLoss?: boolean;
    guaranteedStopLoss?: boolean;
    stopLossTriggerMethod?: ProtoOAOrderTriggerMethod;
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

export interface ISpotwareTradingEvents extends EventMap {
    /**
     * Every execution event on the account, whether or not this client caused it: fills of
     * previously placed pending orders, stop-loss and take-profit triggers, broker-side closes.
     * Requests that resolve with an execution event also emit it here, so a listener sees the
     * account's complete order lifecycle rather than only the parts nobody awaited.
     */
    execution: [event: ProtoOAExecutionEvent];
    /**
     * Order rejections. A rejection answering one of this client's own requests also rejects
     * that request's promise — this event additionally covers rejections that answer nothing,
     * such as a pending order the broker refuses to trigger.
     */
    orderError: [event: ProtoOAOrderErrorEvent];
    /**
     * The broker moved a position's trailing stop-loss. `amendPositionStopLossTakeProfit` and
     * `placeOrder`'s `trailingStopLoss` flag only turn trailing on — the broker then re-prices
     * the stop on its own as the market moves, with no request of yours to await. Without this
     * event, the new stop price is only discoverable by polling `getOpenPositionsAndOrders`.
     */
    trailingStopLossChanged: [event: ProtoOATrailingSLChangedEvent];
}

// The internal superset of every wire field the public place* helpers can set, so each helper
// maps its own params explicitly instead of the request builder having to guess which shape it
// was handed.
type PlaceOrderRequestParams = IPlaceMarketOrderParams & {
    orderType: ProtoOAOrderType;
    limitPrice?: number;
    stopPrice?: number;
    timeInForce?: ProtoOATimeInForce;
    expirationTimestamp?: number;
    baseSlippagePrice?: number;
    slippageInPoints?: number;
};

/**
 * Places/modifies/cancels orders and closes positions, via `client`. Knows nothing about
 * market data streaming. Order mutations have no dedicated response message: the outcome
 * arrives as a ProtoOAExecutionEvent on success, or rejects via ProtoOAOrderErrorEvent (which
 * `client` already treats as an error) on failure. Volume here is in units, not the wire's
 * cents representation; prices other than relative SL/TP stay plain decimals, matching the
 * protocol's own convention (confirmed against Spotware's official SDK, not assumed).
 *
 * Awaiting a place/amend/close call tells you the request was *accepted*. What subsequently
 * happens to the order — a pending order filling minutes later, a stop-loss triggering
 * overnight — arrives unsolicited, so anything long-running should listen to the 'execution'
 * event rather than rely on the returned promise alone.
 */
export class SpotwareTrading extends TypedEventEmitter<ISpotwareTradingEvents> {
    private readonly client: SpotwareClient;

    constructor(client: SpotwareClient) {
        super();
        this.client = client;
        this.client.on('message', (message) => this.handleMessage(message));
    }

    placeMarketOrder(
        params: IPlaceMarketOrderParams,
    ): Promise<ProtoOAExecutionEvent> {
        return this.placeOrder({
            ...params,
            orderType: ProtoOAOrderType.MARKET,
        });
    }

    placeLimitOrder(
        params: IPlaceLimitOrderParams,
    ): Promise<ProtoOAExecutionEvent> {
        return this.placeOrder({
            ...params,
            orderType: ProtoOAOrderType.LIMIT,
        });
    }

    /** A stop entry order: becomes a market order once the market trades through stopPrice. */
    placeStopOrder(
        params: IPlaceStopOrderParams,
    ): Promise<ProtoOAExecutionEvent> {
        return this.placeOrder({ ...params, orderType: ProtoOAOrderType.STOP });
    }

    /** Like a stop order, but fills as a limit order capped at slippageInPoints past stopPrice. */
    placeStopLimitOrder(
        params: IPlaceStopLimitOrderParams,
    ): Promise<ProtoOAExecutionEvent> {
        return this.placeOrder({
            ...params,
            orderType: ProtoOAOrderType.STOP_LIMIT,
        });
    }

    /** A market order that is rejected rather than filled if price has moved beyond the slippage range. */
    placeMarketRangeOrder(
        params: IPlaceMarketRangeOrderParams,
    ): Promise<ProtoOAExecutionEvent> {
        return this.placeOrder({
            ...params,
            orderType: ProtoOAOrderType.MARKET_RANGE,
        });
    }

    async amendOrder(
        params: IAmendOrderParams,
    ): Promise<ProtoOAExecutionEvent> {
        const request = ProtoOAAmendOrderReq.fromPartial({
            ctidTraderAccountId: this.client.ctidTraderAccountId,
            orderId: params.orderId,
            volume:
                params.volume === undefined
                    ? undefined
                    : params.volume * SPOTWARE_VOLUME_SCALE,
            limitPrice: params.limitPrice,
            stopPrice: params.stopPrice,
            stopLoss: params.stopLoss,
            takeProfit: params.takeProfit,
            expirationTimestamp: params.expirationTimestamp,
        });

        const response = await this.client.send(
            ProtoOAPayloadType.PROTO_OA_AMEND_ORDER_REQ,
            ProtoOAAmendOrderReq.encode(request).finish(),
        );

        return ProtoOAExecutionEvent.decode(
            response.payload ?? new Uint8Array(),
        );
    }

    /**
     * Moves the protective orders on an already-open position — trailing a stop, or pulling one
     * up to breakeven. `amendOrder` cannot do this: it targets pending orders, whereas a
     * position's stop-loss and take-profit are properties of the position itself.
     */
    async amendPositionStopLossTakeProfit(
        params: IAmendPositionStopLossTakeProfitParams,
    ): Promise<ProtoOAExecutionEvent> {
        const request = ProtoOAAmendPositionSLTPReq.fromPartial({
            ctidTraderAccountId: this.client.ctidTraderAccountId,
            positionId: params.positionId,
            stopLoss: params.stopLoss,
            takeProfit: params.takeProfit,
            trailingStopLoss: params.trailingStopLoss,
            guaranteedStopLoss: params.guaranteedStopLoss,
            stopLossTriggerMethod: params.stopLossTriggerMethod,
        });

        const response = await this.client.send(
            ProtoOAPayloadType.PROTO_OA_AMEND_POSITION_SLTP_REQ,
            ProtoOAAmendPositionSLTPReq.encode(request).finish(),
        );

        return ProtoOAExecutionEvent.decode(
            response.payload ?? new Uint8Array(),
        );
    }

    async cancelOrder(orderId: number): Promise<ProtoOAExecutionEvent> {
        const request = ProtoOACancelOrderReq.fromPartial({
            ctidTraderAccountId: this.client.ctidTraderAccountId,
            orderId,
        });
        const response = await this.client.send(
            ProtoOAPayloadType.PROTO_OA_CANCEL_ORDER_REQ,
            ProtoOACancelOrderReq.encode(request).finish(),
        );

        return ProtoOAExecutionEvent.decode(
            response.payload ?? new Uint8Array(),
        );
    }

    async closePosition(
        params: IClosePositionParams,
    ): Promise<ProtoOAExecutionEvent> {
        const request = ProtoOAClosePositionReq.fromPartial({
            ctidTraderAccountId: this.client.ctidTraderAccountId,
            positionId: params.positionId,
            volume: params.volume * SPOTWARE_VOLUME_SCALE,
        });

        const response = await this.client.send(
            ProtoOAPayloadType.PROTO_OA_CLOSE_POSITION_REQ,
            ProtoOAClosePositionReq.encode(request).finish(),
        );

        return ProtoOAExecutionEvent.decode(
            response.payload ?? new Uint8Array(),
        );
    }

    async getOpenPositionsAndOrders(): Promise<IOpenPositionsAndOrders> {
        const request = ProtoOAReconcileReq.fromPartial({
            ctidTraderAccountId: this.client.ctidTraderAccountId,
        });
        const response = await this.client.send(
            ProtoOAPayloadType.PROTO_OA_RECONCILE_REQ,
            ProtoOAReconcileReq.encode(request).finish(),
        );
        const reconcile = ProtoOAReconcileRes.decode(
            response.payload ?? new Uint8Array(),
        );

        return { positions: reconcile.position, orders: reconcile.order };
    }

    private async placeOrder(
        params: PlaceOrderRequestParams,
    ): Promise<ProtoOAExecutionEvent> {
        const request = ProtoOANewOrderReq.fromPartial({
            ctidTraderAccountId: this.client.ctidTraderAccountId,
            symbolId: params.symbolId,
            orderType: params.orderType,
            tradeSide: params.tradeSide,
            volume: params.volume * SPOTWARE_VOLUME_SCALE,
            limitPrice: params.limitPrice,
            stopPrice: params.stopPrice,
            timeInForce: params.timeInForce,
            expirationTimestamp: params.expirationTimestamp,
            stopLoss: params.stopLoss,
            takeProfit: params.takeProfit,
            trailingStopLoss: params.trailingStopLoss,
            guaranteedStopLoss: params.guaranteedStopLoss,
            stopTriggerMethod: params.stopTriggerMethod,
            baseSlippagePrice: params.baseSlippagePrice,
            slippageInPoints: params.slippageInPoints,
            comment: params.comment,
            label: params.label,
            clientOrderId: params.clientOrderId,
            positionId: params.positionId,
        });

        const response = await this.client.send(
            ProtoOAPayloadType.PROTO_OA_NEW_ORDER_REQ,
            encodeNewOrderReq(request),
        );

        return ProtoOAExecutionEvent.decode(
            response.payload ?? new Uint8Array(),
        );
    }

    private handleMessage(message: ProtoMessage): void {
        if (
            message.payloadType === ProtoOAPayloadType.PROTO_OA_EXECUTION_EVENT
        ) {
            this.emit(
                'execution',
                ProtoOAExecutionEvent.decode(
                    message.payload ?? new Uint8Array(),
                ),
            );
            return;
        }

        if (
            message.payloadType ===
            ProtoOAPayloadType.PROTO_OA_ORDER_ERROR_EVENT
        ) {
            this.emit(
                'orderError',
                ProtoOAOrderErrorEvent.decode(
                    message.payload ?? new Uint8Array(),
                ),
            );
            return;
        }

        if (
            message.payloadType ===
            ProtoOAPayloadType.PROTO_OA_TRAILING_SL_CHANGED_EVENT
        ) {
            this.emit(
                'trailingStopLossChanged',
                ProtoOATrailingSLChangedEvent.decode(
                    message.payload ?? new Uint8Array(),
                ),
            );
        }
    }
}

// orderType (field 4) and tradeSide (field 5) are required enums with no explicit default, so
// MARKET and BUY — the two most common choices — are dropped by ts-proto and the server rejects
// the order as missing them. See appendRequiredEnumIfDropped.
function encodeNewOrderReq(request: ProtoOANewOrderReq): Uint8Array {
    const writer = ProtoOANewOrderReq.encode(request);
    appendRequiredEnumIfDropped(
        writer,
        4,
        request.orderType,
        ProtoOAOrderType.MARKET,
    );
    appendRequiredEnumIfDropped(
        writer,
        5,
        request.tradeSide,
        ProtoOATradeSide.BUY,
    );

    return writer.finish();
}
