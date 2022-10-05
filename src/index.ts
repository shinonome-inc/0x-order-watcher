import express from 'express';
import { ethers } from 'ethers';

import { LimitOrderFilledEventArgs, OrderCanceledEventArgs } from './types';
import { OrderWatcher } from './order_watcher';
import { getDBConnectionAsync } from './db_connection';
import { logger } from './logger';
import { RPC_URL, EXCHANGE_RPOXY, PORT, SRA_ORDER_EXPIRATION_BUFFER_SECONDS, LOG_LEVEL, CHAIN_ID } from './config';
import * as fs from 'fs';

const outputFilepath = '../log/event_log.csv';

// creates an Express application.
const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// NOTE: WebSocketProvider : https://docs.ethers.io/v5/api/providers/ws-provider/
// const wsProvider = new ethers.providers.WebSocketProvider(WS_RPC_URL);

// Zero-Ex INativeOrdersEvents
const abi = [
    'event OrderCancelled(bytes32 orderHash, address maker)',
    'event LimitOrderFilled(bytes32 orderHash, address maker, address taker, address feeRecipient, address makerToken, address takerToken, uint128 takerTokenFilledAmount, uint128 makerTokenFilledAmount, uint128 takerTokenFeeFilledAmount, uint256 protocolFeePaid, bytes32 pool)',
];
const zeroEx = new ethers.Contract(EXCHANGE_RPOXY, abi);
const provider = new ethers.providers.StaticJsonRpcProvider(RPC_URL);

let orderWatcher: OrderWatcher;
if (require.main === module) {
    (async () => {
        const { chainId } = await provider.getNetwork();
        if (chainId !== CHAIN_ID) {
            throw new Error(`Invalid ChainId: ${CHAIN_ID}!= ${chainId}`);
        }
        if (!ethers.utils.isAddress(EXCHANGE_RPOXY)) {
            throw new Error(`Invalid ZeroEx Address: ${EXCHANGE_RPOXY}`);
        }

        // db is shared among 0x-api and 0x-order-watcher
        const connection = await getDBConnectionAsync();
        orderWatcher = new OrderWatcher(connection, provider);

        logger.info(`${RPC_URL} is connected. ZeroEx: ${EXCHANGE_RPOXY}`);
        logger.info('OrderWatcher is ready. LogLevel: ' + LOG_LEVEL);
    })()
}

// NOTE: https://docs.ethers.io/v5/api/providers/types/#providers-Filter
// NOTE: https://docs.ethers.io/v5/api/providers/types/#providers-Log
// NOTE: https://docs.ethers.io/v5/concepts/events/#events--filters
// subscribe LimitOrderFilled events from ZeroEx contract
const orderFilledEventFilter = zeroEx.filters.LimitOrderFilled();
provider.on(orderFilledEventFilter, (log) => {
    const filledOrderEvent = zeroEx.interface.parseLog(log).args as any as LimitOrderFilledEventArgs;

    setImmediate(async (filledOrderEvent: LimitOrderFilledEventArgs) => {
        // csvのファイルに書き込んでいく
        /* 
            次のデータを書き込む
            orderHash:
            maker:
            taker:
            makerToken:
            takerToken:
            takerTokenFilledAmount:
            makerTokenFilledAmount:
            takerTokenFeeFilledAmount:
         */
        /*
        次のように出力された
        orderHash	maker	taker	feeRecipient	makerToken	takerToken	takerTokenFilledAmount	makerTokenFilledAmount	takerTokenFeeFilledAmount
        0x260e3ade4c5e995074e51c5e6031a7f9ac4c466923cf636a52da5618733ca733	0x260e3ade4c5e995074e51c5e6031a7f9ac4c466923cf636a52da5618733ca733	0x260e3ade4c5e995074e51c5e6031a7f9ac4c466923cf636a52da5618733ca733	0x260e3ade4c5e995074e51c5e6031a7f9ac4c466923cf636a52da5618733ca733	0x260e3ade4c5e995074e51c5e6031a7f9ac4c466923cf636a52da5618733ca733	0x260e3ade4c5e995074e51c5e6031a7f9ac4c466923cf636a52da5618733ca733	2200000000000000000	1500000000000000000	3450000000000000000
        */
        fs.writeFile(outputFilepath, 'orderHash\tmaker\ttaker\tfeeRecipient\tmakerToken\ttakerToken\ttakerTokenFilledAmount\tmakerTokenFilledAmount\ttakerTokenFeeFilledAmount' + `\n` + filledOrderEvent.orderHash + '\t' + filledOrderEvent.maker + '\t' + filledOrderEvent.taker + '\t' + filledOrderEvent.feeRecipient + '\t' + filledOrderEvent.makerToken + '\t' + filledOrderEvent.takerToken + '\t' + filledOrderEvent.takerTokenFilledAmount + '\t' + filledOrderEvent.makerTokenFilledAmount + '\t' + filledOrderEvent.takerTokenFeeFilledAmount, (err) => {
            // 書き出しに失敗した場合
            if(err){
                  logger.error(err)
            }
                // 書き出しに成功した場合
                else{
                }
              });
        
        /*列を変える場合
        orderHash	0x260e3ade4c5e995074e51c5e6031a7f9ac4c466923cf636a52da5618733ca733
        maker	0x260e3ade4c5e995074e51c5e6031a7f9ac4c466923cf636a52da5618733ca733
        taker	0x260e3ade4c5e995074e51c5e6031a7f9ac4c466923cf636a52da5618733ca733
        feeRecipient	0x260e3ade4c5e995074e51c5e6031a7f9ac4c466923cf636a52da5618733ca733
        makerToken	0x260e3ade4c5e995074e51c5e6031a7f9ac4c466923cf636a52da5618733ca733
        takerToken	0x260e3ade4c5e995074e51c5e6031a7f9ac4c466923cf636a52da5618733ca733
        takerTokenFilledAmount	3450000000000000000
        makerTokenFilledAmount	1500000000000000000
        takerTokenFeeFilledAmount	3450000000000000000
        */
       /*
        fs.writeFile(outputFilepath, 'orderHash\t'+filledOrderEvent.orderHash + '\nmaker\t'+filledOrderEvent.maker+'\ntaker\t'+filledOrderEvent.taker+'\nfeeRecipient\t'+filledOrderEvent.feeRecipient+'\nmakerToken\t'+filledOrderEvent.makerToken+'\ntakerToken\t'+filledOrderEvent.takerToken+'\ntakerTokenFilledAmount\t'+filledOrderEvent.takerTokenFeeFilledAmount+'\nmakerTokenFilledAmount\t'+filledOrderEvent.makerTokenFilledAmount+'\ntakerTokenFeeFilledAmount\t'+filledOrderEvent.takerTokenFeeFilledAmount , (err) => {
            // 書き出しに失敗した場合
            if(err){
                  logger.error(err)
            }
                // 書き出しに成功した場合
                else{
                }
              });
        */

        logger.debug('filledOrderEvent: orderHash ' + filledOrderEvent.orderHash);
        await orderWatcher.updateFilledOrdersAsync([filledOrderEvent]);
    }, filledOrderEvent);
});

// subscribe OrderCancelled events from ZeroEx contract
const orderCanceledEventFilter = zeroEx.filters.OrderCancelled();
provider.on(orderCanceledEventFilter, (log) => {
    const canceledOrderEvent = zeroEx.interface.parseLog(log).args as any as OrderCanceledEventArgs;

    setImmediate(async (canceledOrderEvent: OrderCanceledEventArgs) => {
        logger.debug('canceledOrderEvent: orderHash ', canceledOrderEvent);
        await orderWatcher.updateCanceledOrdersByHashAsync([canceledOrderEvent.orderHash]);
    }, canceledOrderEvent);
});

// periodically remove expired orders from DB
const timerId = setInterval(async () => {
    logger.debug('start syncing unfilled orders...');
    try {
        await orderWatcher.syncFreshOrders();
    } catch (error) {
        logger.error(error);
    }
}, SRA_ORDER_EXPIRATION_BUFFER_SECONDS * 2000);

app.post('/ping', function (req, res) {
    res.json({ msg: 'pong, Got a POST request' });
});

// receive POST request from 0x-api `POST orderbook/v1/order`.
app.post('/orders', async function (req: express.Request, res) {
    try {
        logger.debug(req.body);
        // save orders to DB
        await orderWatcher.postOrdersAsync(req.body);
        res.status(200).json();
    } catch (err) {
        logger.error(err);
        res.status(500).json({ error: err.message });
    }
});

app.listen(PORT, () => console.log(`app listening on port ${PORT} !`));

process.on('uncaughtException', (err) => {
    logger.error(err);
    clearInterval(timerId);
    process.exit(1);
});

process.on('unhandledRejection', (err) => {
    if (err) {
        logger.error(err);
    }
});
