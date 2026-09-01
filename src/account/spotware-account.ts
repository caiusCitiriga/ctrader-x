import { SpotwareRequestError, type SpotwareClient } from '../client';
import { fromMoneyDigits } from '../shared/spotware-money';
import { SPOTWARE_VOLUME_SCALE } from '../shared/spotware-scale';
import {
    TypedEventEmitter,
    type EventMap,
} from '../shared/typed-event-emitter';
import {
    ProtoMessage,
    ProtoOAAccountsTokenInvalidatedEvent,
    ProtoOAAsset,
    ProtoOAAssetListReq,
    ProtoOAAssetListRes,
    ProtoOAExpectedMarginReq,
    ProtoOAExpectedMarginRes,
    ProtoOAGetPositionUnrealizedPnLReq,
    ProtoOAGetPositionUnrealizedPnLRes,
    ProtoOAMarginCall,
    ProtoOAMarginCallListReq,
    ProtoOAMarginCallListRes,
    ProtoOAMarginChangedEvent,
    ProtoOAMarginCallTriggerEvent,
    ProtoOAMarginCallUpdateEvent,
    ProtoOAPayloadType,
    ProtoOATrader,
    ProtoOATraderReq,
    ProtoOATraderRes,
    ProtoOATraderUpdatedEvent,
} from '../types';

export interface IExpectedMargin {
    /** In units, converted back from the wire's cents form. */
    volume: number;
    buyMargin: number;
    sellMargin: number;
}

export interface IPositionUnrealizedPnL {
    positionId: number;
    grossUnrealizedPnL: number;
    netUnrealizedPnL: number;
}

export interface IMarginChange {
    positionId: number;
    usedMargin: number;
}

export interface IGetExpectedMarginParams {
    symbolId: number;
    /** In units (e.g. 1000 for 1000 units) — converted internally, not the wire's cents form. */
    volumes: number[];
}

export interface ISpotwareAccountEvents extends EventMap {
    /** Account details changed — balance moved, leverage or access rights were altered. */
    traderUpdated: [trader: ProtoOATrader];
    /** Margin used by a position changed, with the amount already converted to a decimal. */
    marginChanged: [change: IMarginChange];
    marginCallTriggered: [marginCall: ProtoOAMarginCall];
    marginCallUpdated: [marginCall: ProtoOAMarginCall];
    /**
     * The account was disconnected server-side (broker maintenance, session revoked). The
     * transport reconnects on its own; this reports the account-level cause behind it.
     */
    accountDisconnected: [];
    /**
     * Access was revoked for the token in use. Reconnecting will not help — the OAuth flow has
     * to be run again — so this is the one account event worth surfacing to a human.
     */
    tokenInvalidated: [accountIds: number[], reason?: string];
}

/**
 * Account-level state and the events that change it: balance and leverage, the assets the
 * account can hold, margin estimates, unrealized PnL, and margin calls.
 *
 * Monetary values are transmitted as integers with a per-response `moneyDigits` exponent, so
 * anything this class returns as a plain number has already been converted using the exponent
 * from that same response — mixing a raw wire value with a converted one is the easiest way to
 * be off by two orders of magnitude.
 *
 * Note that cTrader does not transmit equity directly. It is balance plus the net unrealized
 * PnL of open positions: `getBalance()` plus the sum of `getPositionsUnrealizedPnL()`.
 */
export class SpotwareAccount extends TypedEventEmitter<ISpotwareAccountEvents> {
    private readonly client: SpotwareClient;

    constructor(client: SpotwareClient) {
        super();
        this.client = client;
        this.client.on('message', (message) => this.handleMessage(message));
    }

    /** The full account record, with monetary fields left in their raw scaled form. */
    async getTrader(): Promise<ProtoOATrader> {
        const request = ProtoOATraderReq.fromPartial({
            ctidTraderAccountId: this.client.ctidTraderAccountId,
        });
        const response = await this.client.send(
            ProtoOAPayloadType.PROTO_OA_TRADER_REQ,
            ProtoOATraderReq.encode(request).finish(),
        );

        const trader = ProtoOATraderRes.decode(
            response.payload ?? new Uint8Array(),
        ).trader;
        // `trader` is proto2-required, but ts-proto's useOptionals=messages types every nested
        // message as optional. A response without it is malformed rather than a normal absence,
        // so failing here beats handing back an undefined every caller would have to check.
        if (!trader) {
            throw new SpotwareRequestError(
                'The trader response carried no account details',
            );
        }

        return trader;
    }

    /** The account balance as a decimal, converted with the account's own moneyDigits. */
    async getBalance(): Promise<number> {
        const trader = await this.getTrader();

        return fromMoneyDigits(trader.balance, trader.moneyDigits);
    }

    async getAssets(): Promise<ProtoOAAsset[]> {
        const request = ProtoOAAssetListReq.fromPartial({
            ctidTraderAccountId: this.client.ctidTraderAccountId,
        });
        const response = await this.client.send(
            ProtoOAPayloadType.PROTO_OA_ASSET_LIST_REQ,
            ProtoOAAssetListReq.encode(request).finish(),
        );

        return ProtoOAAssetListRes.decode(response.payload ?? new Uint8Array())
            .asset;
    }

    /** Margin required to open the given volumes, before actually placing anything. */
    async getExpectedMargin(
        params: IGetExpectedMarginParams,
    ): Promise<IExpectedMargin[]> {
        const request = ProtoOAExpectedMarginReq.fromPartial({
            ctidTraderAccountId: this.client.ctidTraderAccountId,
            symbolId: params.symbolId,
            volume: params.volumes.map(
                (volume) => volume * SPOTWARE_VOLUME_SCALE,
            ),
        });

        const response = await this.client.send(
            ProtoOAPayloadType.PROTO_OA_EXPECTED_MARGIN_REQ,
            ProtoOAExpectedMarginReq.encode(request).finish(),
        );
        const decoded = ProtoOAExpectedMarginRes.decode(
            response.payload ?? new Uint8Array(),
        );

        return decoded.margin.map((margin) => ({
            volume: margin.volume / SPOTWARE_VOLUME_SCALE,
            buyMargin: fromMoneyDigits(margin.buyMargin, decoded.moneyDigits),
            sellMargin: fromMoneyDigits(margin.sellMargin, decoded.moneyDigits),
        }));
    }

    async getPositionsUnrealizedPnL(): Promise<IPositionUnrealizedPnL[]> {
        const request = ProtoOAGetPositionUnrealizedPnLReq.fromPartial({
            ctidTraderAccountId: this.client.ctidTraderAccountId,
        });
        const response = await this.client.send(
            ProtoOAPayloadType.PROTO_OA_GET_POSITION_UNREALIZED_PNL_REQ,
            ProtoOAGetPositionUnrealizedPnLReq.encode(request).finish(),
        );
        const decoded = ProtoOAGetPositionUnrealizedPnLRes.decode(
            response.payload ?? new Uint8Array(),
        );

        return decoded.positionUnrealizedPnL.map((pnl) => ({
            positionId: pnl.positionId,
            grossUnrealizedPnL: fromMoneyDigits(
                pnl.grossUnrealizedPnL,
                decoded.moneyDigits,
            ),
            netUnrealizedPnL: fromMoneyDigits(
                pnl.netUnrealizedPnL,
                decoded.moneyDigits,
            ),
        }));
    }

    async getMarginCalls(): Promise<ProtoOAMarginCall[]> {
        const request = ProtoOAMarginCallListReq.fromPartial({
            ctidTraderAccountId: this.client.ctidTraderAccountId,
        });
        const response = await this.client.send(
            ProtoOAPayloadType.PROTO_OA_MARGIN_CALL_LIST_REQ,
            ProtoOAMarginCallListReq.encode(request).finish(),
        );

        return ProtoOAMarginCallListRes.decode(
            response.payload ?? new Uint8Array(),
        ).marginCall;
    }

    private handleMessage(message: ProtoMessage): void {
        const payload = message.payload ?? new Uint8Array();

        switch (message.payloadType) {
            case ProtoOAPayloadType.PROTO_OA_TRADER_UPDATE_EVENT: {
                const trader = ProtoOATraderUpdatedEvent.decode(payload).trader;
                if (trader) {
                    this.emit('traderUpdated', trader);
                }
                return;
            }
            case ProtoOAPayloadType.PROTO_OA_MARGIN_CHANGED_EVENT: {
                const event = ProtoOAMarginChangedEvent.decode(payload);
                this.emit('marginChanged', {
                    positionId: event.positionId,
                    usedMargin: fromMoneyDigits(
                        event.usedMargin,
                        event.moneyDigits,
                    ),
                });
                return;
            }
            case ProtoOAPayloadType.PROTO_OA_MARGIN_CALL_TRIGGER_EVENT: {
                const marginCall =
                    ProtoOAMarginCallTriggerEvent.decode(payload).marginCall;
                if (marginCall) {
                    this.emit('marginCallTriggered', marginCall);
                }
                return;
            }
            case ProtoOAPayloadType.PROTO_OA_MARGIN_CALL_UPDATE_EVENT: {
                const marginCall =
                    ProtoOAMarginCallUpdateEvent.decode(payload).marginCall;
                if (marginCall) {
                    this.emit('marginCallUpdated', marginCall);
                }
                return;
            }
            case ProtoOAPayloadType.PROTO_OA_ACCOUNT_DISCONNECT_EVENT:
                this.emit('accountDisconnected');
                return;
            case ProtoOAPayloadType.PROTO_OA_ACCOUNTS_TOKEN_INVALIDATED_EVENT: {
                const event =
                    ProtoOAAccountsTokenInvalidatedEvent.decode(payload);
                this.emit(
                    'tokenInvalidated',
                    event.ctidTraderAccountIds,
                    event.reason,
                );
                return;
            }
            default:
                return;
        }
    }
}
