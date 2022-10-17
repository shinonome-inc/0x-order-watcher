import { LimitOrder } from '@0x/protocol-utils';
import { Connection, In, LessThanOrEqual } from 'typeorm';
import { BigNumber, providers, ethers } from 'ethers';

import { orderUtils } from './utils/order_utils';
import { LimitOrderFilledEventArgs, SignedLimitOrder } from './types';
import { EXCHANGE_RPOXY, SRA_ORDER_EXPIRATION_BUFFER_SECONDS } from './config';
import { ONE_SECOND_MS } from './constants';
import { SignedOrderV4Entity } from './entities';
import { logger } from './logger';
import NativeOrdersFeature from './abi/NativeOrdersFeature.json';

export interface OrderWatcherInterface {
    postOrdersAsync(orders: SignedLimitOrder[]): Promise<void>;
    updateFilledOrderAsync(event: LimitOrderFilledEventArgs): Promise<void>;
    updateFilledOrdersAsync(events: LimitOrderFilledEventArgs[]): Promise<void>;
    updateCanceledOrdersByHashAsync(orderHashes: string[]): Promise<void>;
    syncFreshOrders(): Promise<void>;
}

const BN = BigNumber.from;

export class OrderWatcher implements OrderWatcherInterface {
    private readonly _connection: Connection;
    private readonly _provider: providers.JsonRpcProvider;
    private readonly _zeroEx: any;

    constructor(connection: Connection, provider: providers.JsonRpcProvider) {
        this._connection = connection;
        this._provider = provider;
        this._zeroEx = new ethers.Contract(
            EXCHANGE_RPOXY,
            new ethers.utils.Interface(NativeOrdersFeature.abi),
            provider,
        );
    }

    /// @dev assume schema has already been validated.
    public async postOrdersAsync(orders: SignedLimitOrder[]): Promise<void> {
        // validate whether orders are valid format.
        const validOrders = await this.filterFreshOrders(orders);

        // Saves all given entities in the database. If entities do not exist in the database then inserts, otherwise updates.
        await this._connection.getRepository(SignedOrderV4Entity).save(
            validOrders.map((order) => {
                const limitOrder = new LimitOrder(order);
                return orderUtils.serializeOrder({
                    order,
                    metaData: {
                        orderHash: limitOrder.getHash(),
                        remainingFillableTakerAmount: order.takerAmount,
                    },
                });
            }),
        );
    }

    /// @dev
    /// if remainingFillableTakerAmountが0なら完全約定であるので削除する
    /// else 部分約定とみなして、remainingFillableTakerAmountを更新
    public async updateFilledOrderAsync(event: LimitOrderFilledEventArgs): Promise<void> {
        const signedOrdersEntity = await this._connection.getRepository(SignedOrderV4Entity).findOne(event.orderHash);
        if (!signedOrdersEntity?.remainingFillableTakerAmount) {
            return;
        }
        const remainingFillableTakerAmount = BN(signedOrdersEntity.remainingFillableTakerAmount ?? 0).sub(
            BN(event.takerTokenFilledAmount),
        );
        if (remainingFillableTakerAmount.isZero()) {
            await this._connection.getRepository(SignedOrderV4Entity).remove(signedOrdersEntity);
        } else {
            signedOrdersEntity.remainingFillableTakerAmount = remainingFillableTakerAmount.toString();
            await this._connection.getRepository(SignedOrderV4Entity).update(event.orderHash, signedOrdersEntity);
        }
    }

    public async updateFilledOrdersAsync(events: LimitOrderFilledEventArgs[]): Promise<void> {
        const orderEntities = await this._connection.manager.find(SignedOrderV4Entity, {
            where: {
                hash: In(events.map((event) => event.orderHash)),
            },
        });
        const fullyFilledOrders: SignedOrderV4Entity[] = [];
        const partiallyFilledOrders: SignedOrderV4Entity[] = [];
        orderEntities.forEach((orderEntity) => {
            const takerTokenFilledAmount =
                events.find((event) => orderEntity?.hash == event.orderHash)?.takerTokenFilledAmount ?? 0;
            const remainingFillableTakerAmount = BN(orderEntity?.remainingFillableTakerAmount).sub(
                BN(takerTokenFilledAmount),
            );

            orderEntity.remainingFillableTakerAmount = remainingFillableTakerAmount.toString();

            if (remainingFillableTakerAmount.isZero()) {
                fullyFilledOrders.push(orderEntity);
            } else {
                partiallyFilledOrders.push(orderEntity);
            }
        });
        const promises: Promise<any>[] = [];
        if (fullyFilledOrders.length > 0) {
            // Deletes entities by a given criteria.  Does not check if entity exist in the database.
            promises.push(
                this._connection
                    .getRepository(SignedOrderV4Entity)
                    .delete(fullyFilledOrders.map((order) => (order?.hash ? order.hash : ''))),
            );
        }
        if (partiallyFilledOrders.length > 0) {
            // Saves all given entities in the database. If entities do not exist in the database then inserts, otherwise updates.
            promises.push(this._connection.getRepository(SignedOrderV4Entity).save(partiallyFilledOrders));
        }

        await Promise.all(promises);
    }

    public async updateCanceledOrdersByHashAsync(orderHashes: string[]): Promise<void> {
        await this._connection.getRepository(SignedOrderV4Entity).delete(orderHashes);
    }

    /// @dev TODO: makerが十分な残高を持っているか, allowanceが十分か
    public async syncFreshOrders() {
        // fetch expired orders
        const expiryTime = Math.floor(Date.now() / ONE_SECOND_MS) + SRA_ORDER_EXPIRATION_BUFFER_SECONDS;
        const expiredOrders = await this._connection.getRepository(SignedOrderV4Entity).find({
            where: {
                expiry: LessThanOrEqual(expiryTime),
            },
        });
        if (expiredOrders.length > 0) {
            await this._connection.getRepository(SignedOrderV4Entity).delete(
                expiredOrders.map((order) => {
                    return order?.hash ? order.hash : '';
                }),
            );
            logger.info(`Expired orders: ${expiredOrders.reduce((acc, order) => `${order?.hash}, ${acc}`, '')}`);
        }
    }

    /// @dev orderが無効ならエラーを投げる
    ///  - 有効期限が切れていないか
    ///  - chainIdが正しいか
    ///  - verifyingContractが正しいZeroExProxyのアドレスか
    ///  - 署名が正しいか
    ///  - makerが十分な残高を持っているか, allowanceが十分か zeroExに問い合わせる
    private async filterFreshOrders(orders: SignedLimitOrder[]) {
        const limitOrders = [];
        const signatures = [];
        const validOrders: SignedLimitOrder[] = [];

        for (const order of orders) {
            const { signature, ...limitOrder } = order;
            limitOrders.push(limitOrder);
            signatures.push(signature);
        }
        const {
            orderInfos,
            actualFillableTakerTokenAmounts,
            isSignatureValids,
        }: {
            orderInfos: {
                orderHash: string;
                status: number;
                takerTokenFilledAmount: BigNumber;
            }[];
            actualFillableTakerTokenAmounts: BigNumber[];
            isSignatureValids: boolean[];
        } = await this._zeroEx.batchGetLimitOrderRelevantStates(limitOrders, signatures);
        // NOTE: XXX
        // order-watcherにbugある可能性
        // eventsとtrades.csvで同じorderHashが繰り返し出てくる
        // TODO: order-watcher動くか？
        // TODO: amaterasu_clientにcanceled_orderを管理するキューを作ったので機能しているか確認する
        // TODO: 約定した注文をキューに入れる
        isSignatureValids.forEach((isValidSig: Boolean, index) => {
            if (!isValidSig) {
                throw new Error('Invalid signature');
            }
            if (
                actualFillableTakerTokenAmounts[index].gt(0) &&
                (orderInfos[index].status === 1 || orderInfos[index].status === 2)
            ) {
                validOrders.push(orders[index]);
            }
        });
        return validOrders;
    }
}
