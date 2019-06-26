// Author: Whatshiywl

import axios from 'axios';
const urls = require('./urls.json');
import FormData from 'form-data';
import _ from 'lodash';
import * as fs from 'fs';
import moment from 'moment';

const TRADE_DELTA_THRESHOLD = 300;
const MIN_MERCHANTS = 4;
const MIN_PP = 500;
const MAX_CHANGE = 0.1;
const TRY_BUY_FOR_SECONDS = 5;

var merchants = 0;
var csrf = '';
const availableResources = {
    wood: 0,
    stone: 0,
    iron: 0
};
let pp = 0;

function sleep(time: number) {
    return new Promise(resolve => {
        setTimeout(() => {
            resolve();
        }, time);
    });
}

async function axiosGet(url: string, gameData = false) {
    const headers = getAxiosHeaders();
    if(!gameData) delete headers["tribalwars-ajax"];
    const responseData = (await axios.get(url, {headers})).data;
    if(responseData.error) throw responseData.error;
    else if(responseData.response !== undefined && responseData.response === false) throw responseData;
    else return responseData;
}

async function axiosPost(url: string, data: FormData, gameData = false) {
    const headers = {...getAxiosHeaders(), ...data.getHeaders()};
    if(!gameData) delete headers["tribalwars-ajax"];
    const responseData = (await axios.post(url, data, {headers})).data;
    if(responseData.error) throw responseData.error;
    else if(responseData.response !== undefined && responseData.response === false) throw responseData;
    else return responseData;
}

async function trade(action: 'buy' | 'sell', res: 'wood' | 'stone' | 'iron', beginAmount: number) {
    try {
        const actionMultiplier = action === 'sell' ? -1 : 1;
        let beginUrl = urls.exchangeBegin.url;
        if(csrf) beginUrl += `&h=${csrf}`;
        beginUrl += `&client_time=${Math.floor(Date.now()/1000)}`;
        const beginData = new FormData();
        beginData.append(`${action}_${res}`, 1);
        const beginResponse = await axiosPost(beginUrl, beginData);
        const hash = beginResponse[0].rate_hash;
        const confirmAmount = actionMultiplier*beginResponse[0].amount;
        const amountChange = (confirmAmount-beginAmount)/beginAmount;
        if(amountChange > 0) {
            if(action === 'buy') {
                // Do nothing: will buy at better price
            } else if(Math.abs(amountChange) > MAX_CHANGE) {
                throw `amountChange: ${amountChange} (${beginAmount} -> ${confirmAmount})`;
            }
        } else if (amountChange < 0) {
            if(action === 'sell') {
                // Do nothing: will sell at better price
            } else if(Math.abs(amountChange) > MAX_CHANGE) {
                throw `amountChange: ${amountChange} (${beginAmount} -> ${confirmAmount})`;
            }
        }

        await sleep(100);

        let confirmUrl = urls.exchangeConfirm.url;
        if(csrf) confirmUrl += `&h=${csrf}`;
        confirmUrl += `&client_time=${Math.floor(Date.now()/1000)}`;
        const confirmData = new FormData();
        confirmData.append('mb', 1);
        confirmData.append(`rate_${res}`, hash);
        confirmData.append(`${action}_${res}`, confirmAmount);
        const confirmResponse = await axiosPost(confirmUrl, confirmData);
        const actualAmount = actionMultiplier*confirmResponse.transactions[0].amount;
        const merchants = confirmResponse.data.merchants;

        return {
            attempt: beginAmount,
            actual: actualAmount,
            merchants
        };
    } catch (error) {
        // console.error(`error buying:`, error.message || error);
        return {error};
    }
}

async function scan(every: number, n = 0, i = 0) {
    try {
        let url = urls.checkMarket.url;
        url += `&client_time=${Math.floor(Date.now()/1000)}`;
        const r = await axiosGet(url, true);
        const response = r.response;
        merchants = response.merchants;
        const gameData = r.game_data;
        csrf = gameData.csrf;
        Object.keys(availableResources).forEach(key => {
            availableResources[key] = gameData.village[key];
        });
        pp = gameData.player.pp;

        const resources = [
            {name: 'wood', price: 0}, 
            {name: 'stone', price: 0}, 
            {name: 'iron', price: 0}
        ];
        resources.forEach(res => {
            res.price = calculateRateForOnePoint(
                response.constants, 
                response.stock[res.name], 
                response.capacity[res.name], 
                response.tax
            );
        });

        const toBuy = _.maxBy(resources, 'price') as {name: 'wood' | 'stone' | 'iron', price: number};
        const toSell = _.minBy(resources, 'price') as {name: 'wood' | 'stone' | 'iron', price: number};;
        const delta = toBuy.price - toSell.price;
        
        if(delta >= TRADE_DELTA_THRESHOLD) {
            log(`wood ${resources[0].price}, stone ${resources[1].price}, iron ${resources[2].price}`);
            log(`sell ${toSell.name}, buy ${toBuy.name}, delta ${delta}`);
            if(merchants >= MIN_MERCHANTS) {
                if(toSell.price <= availableResources[toSell.name] && pp >= MIN_PP) {
                    const sellResult = await trade('sell', toSell.name, toSell.price);
                    if(!sellResult.error) {
                        await sleep(1000);
                        let buyTimeout = true;
                        const start = Date.now();
                        while(Date.now() - start < TRY_BUY_FOR_SECONDS*1000) {
                            const buyResult = await trade('buy', toBuy.name, toBuy.price);
                            if(!buyResult.error) {
                                const sellAttempt = sellResult.attempt;
                                const soldBy = sellResult.actual;
                                const buyAttempt = buyResult.attempt;
                                const boughtBy = buyResult.actual;
                                log(`Trade successful!`);
                                log(`Attempted: ${sellAttempt} -> ${buyAttempt} (${100*(buyAttempt-sellAttempt)/sellAttempt}% profit)`);
                                log(`Actual: ${soldBy} -> ${boughtBy} (${100*(boughtBy-soldBy)/soldBy}% profit)`);
                                // console.log();
                                buyTimeout = false;
                                break;
                            } else {
                                logError(`ABORT BUYING because: ${buyResult.error.message || buyResult.error}`);
                                await sleep(500);
                            }
                        }
                        if(buyTimeout) {
                            logError(`ABORT BUYING because timeout: ${Date.now()-start}`);
                        }
                    } else {
                        logError(`ABORT SELLING because: ${sellResult.error.message || sellResult.error}`);
                    }
                } else {
                    logError(`ABORT TRADE because resources: wood=${availableResources.wood} stone=${availableResources.stone} iron=${availableResources.iron} pp=${pp}`);
                }
            } else {
                logError(`ABORT TRADE because merchants: ${merchants}`);
            }
        }
    } catch (error) {
        logError(`scan error: ${error.message || error.error || JSON.stringify(error)}`);
    } finally {
        await sleep(every);
        i++;
        if(n <= 0 || i < n) {
            scan(every, n, i);
        }
    }
}

function calculateCost(constants: any, stock: number, capacity: number, tax: {buy: number, sell: number}, c: number) {
    return (1 + (0 <= c ? tax.buy : tax.sell)) * (calculateMarginalPrice(constants, stock, capacity) + calculateMarginalPrice(constants, stock - c, capacity)) * c / 2;
}

function calculateMarginalPrice(constants: any, stock: number, capacity: number) {
    return constants.resource_base_price - constants.resource_price_elasticity * stock / (capacity + constants.stock_size_modifier);
}

function calculateRateForOnePoint(constants: any, stock: number, capacity: number, tax: {buy: number, sell: number}) {
    for (var t = (tax.buy, calculateMarginalPrice(constants, stock, capacity)), c = Math.floor(1 / t), i = calculateCost(constants, stock, capacity, tax, c), n = 0; 1 < i && n < 50; ) {
        c--;
        n++;
        i = calculateCost(constants, stock, capacity, tax, c);
    }
    return c
}

function getAxiosHeaders() {
    const cookieObj = {
        sid: fs.readFileSync('sid.txt').toString()
    };
    const cookie = Object.keys(cookieObj).map(key => `${key}=${cookieObj[key]};`).join(' ');
    return {
        cookie,
        'tribalwars-ajax': 1
    };
}

function log(message: string) {
    message = `${moment().format('YYYY MM DD HH:mm:ss')} - ${message}\n`;
    fs.appendFileSync('info.log', message);
}

function logError(error: any) {
    error = error.message || error.error || JSON.stringify(error);
    error = `${moment().format('YYYY MM DD HH:mm:ss')} - ${error}\n`;
    fs.appendFileSync('error.log', error);
}

log('START');
scan(1000)
.then(() => {})
.catch(logError);
