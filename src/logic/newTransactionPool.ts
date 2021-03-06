import { Account, Transaction, TransactionStatus } from 'src/helpers/types';
import { generateAddressByPublicKey, getOrCreateAccount } from 'src/helpers/account.utils';
import { transactionSortFunc } from 'src/helpers/transaction.utils';
import * as constants from 'src/helpers/constants.js';
import * as transactionTypes from 'src/helpers/transactionTypes.js';
import { AccountSessions } from 'src/helpers/accountSessions';

declare class TransactionPoolScope {
    logger: any;
    transactionLogic: any;
    db: any;
    bus: any;
}

class TransactionPool {

    private pool: { [transactionId: string]: Transaction } = {};

    poolByRecipient: { [recipientId: string]: Array<Transaction> } = {};
    poolBySender: { [senderId: string]: Array<Transaction> } = {};

    locked: boolean = false;

    scope: TransactionPoolScope = {} as TransactionPoolScope;

    constructor({ transactionLogic, logger, db, bus }: TransactionPoolScope) {
        this.scope.transactionLogic = transactionLogic;
        this.scope.logger = logger;
        this.scope.db = db;
        this.scope.bus = bus;
    }

    lock(): void {
        this.locked = true;
    }

    unlock(): void {
        this.locked = false;
    }

    getLockStatus(): boolean {
        return this.locked;
    }

    getTransactionsByRecipientId(recipientId): Array<Transaction> {
        return this.poolByRecipient[recipientId] || [];
    }

    getTransactionsBySenderId(senderId): Array<Transaction> {
        return this.poolBySender[senderId] || [];
    }

    async removeTransactionBySenderId(senderId: string): Promise<Array<Transaction>> {
        const removedTransactions = [];
        const transactions = this.getTransactionsBySenderId(senderId);
        for (const trs of transactions) {
            const removed = await this.remove(trs);
            if (removed) {
                removedTransactions.push(trs);
            }
        }
        return removedTransactions;
    }

    async removeTransactionByRecipientId(address: string): Promise<Array<Transaction>> {
        const removedTransactions = [];
        const transactions = this.getTransactionsByRecipientId(address);
        for (const trs of transactions) {
            const removed = await this.remove(trs);
            if (removed) {
                removedTransactions.push(trs);
            }
        }
        return removedTransactions;
    }

    async push(trs: Transaction, broadcast: boolean = false, force: boolean = false) {
        if ((this.locked && !force)) {
            return false;
        }

        if (this.has(trs)) {
            this.scope.logger.error(`[TransactionPool][tryToPushExisted][has]: ${JSON.stringify(trs)}`);
            return false;
        }

        if (this.isPotentialConflict(trs)) {
            delete this.pool[trs.id];
            return false;
        }

        this.pool[trs.id] = trs;
        trs.status = TransactionStatus.PUT_IN_POOL;

        if (!this.poolBySender[trs.senderId]) {
            this.poolBySender[trs.senderId] = [];
        }
        this.poolBySender[trs.senderId].push(trs);

        if (trs.type === transactionTypes.SEND) {
            if (!this.poolByRecipient[trs.recipientId]) {
                this.poolByRecipient[trs.recipientId] = [];
            }
            this.poolByRecipient[trs.recipientId].push(trs);
        }

        try {
            await this.scope.transactionLogic.newApplyUnconfirmed(trs);
            trs.status = TransactionStatus.UNCOFIRM_APPLIED;
            this.scope.logger.debug(`TransactionStatus.UNCONFIRM_APPLIED ${JSON.stringify(trs)}`);
        } catch (e) {
            delete this.pool[trs.id];
            trs.status = TransactionStatus.DECLINED;
            this.scope.logger.error(`[TransactionPool][push]: ${e}`);
            this.scope.logger.error(`[TransactionPool][push][stack]:\n${e.stack}`);
            return false;
        }

        if (broadcast) {
            this.scope.bus.message('transactionPutInPool', trs);
        }
        return true;
    }

    async remove(trs: Transaction) {
        if (!this.pool[trs.id]) {
            return false;
        }

        try {
            await this.scope.transactionLogic.newUndoUnconfirmed(trs);
        } catch (e) {
            this.scope.logger.error(`[TransactionPool][remove]: ${e}`);
            this.scope.logger.error(`[TransactionPool][remove][stack]: \n ${e.stack}`);
        }

        delete this.pool[trs.id];

        this.poolBySender[trs.senderId] = this.poolBySender[trs.senderId].filter(t => t.id !== trs.id);

        this.poolByRecipient[trs.recipientId] =
            (this.poolByRecipient[trs.recipientId] || []).filter(t => t.id !== trs.id);
        return true;
    }

    get(id: string): Transaction {
        return this.pool[id];
    }

    pop(trs: Transaction): Transaction {
        const deletedValue = this.get(trs.id);
        this.remove(trs);
        return deletedValue;
    }

    has(trs: Transaction) {
        return Boolean(this.pool[trs.id]);
    }

    async popSortedUnconfirmedTransactions(limit: number): Promise<Array<Transaction>> {
        const transactions = Object.values(this.pool).sort(transactionSortFunc).slice(0, limit);
        for (const trs of transactions) {
            await this.remove(trs);
        }

        return transactions;
    }

    isPotentialConflict(trs: Transaction) {
        const senderId = generateAddressByPublicKey(trs.senderPublicKey);
        const recipientTrs = this.poolByRecipient[senderId] || [];
        const senderTrs = this.poolBySender[senderId] || [];
        const dependTransactions = [...recipientTrs, ...senderTrs];

        if (dependTransactions.length === 0) {
            return false;
        }

        if (trs.type === transactionTypes.SIGNATURE) {
            return true;
        }

        if (
            trs.type === transactionTypes.VOTE &&
            dependTransactions.find((t: Transaction) => t.type === transactionTypes.VOTE)
        ) {
            return true;
        }

        if (
            trs.type === transactionTypes.REFERRAL &&
            dependTransactions.find((t: Transaction) => t.type === transactionTypes.REFERRAL)
        ) {
            return true;
        }

        dependTransactions.push(trs);
        dependTransactions.sort(transactionSortFunc);
        return dependTransactions.indexOf(trs) !== (dependTransactions.length - 1);
    }

    getSize(): number {
        return Object.keys(this.pool).length;
    }

    getTransactions = (
        { limit = constants.maxSharedTxs, senderPublicKey }: { limit: number, senderPublicKey: string }
    ): { transactions: Array<Transaction>, count: number } => {
        if (senderPublicKey) {
            const senderId = generateAddressByPublicKey(senderPublicKey);
            const recipientTrs = this.poolByRecipient[senderId] || [];
            const senderTrs = this.poolBySender[senderId] || [];
            const dependTransactions = [...recipientTrs, ...senderTrs];

            return {
                transactions: dependTransactions.sort(transactionSortFunc).slice(
                    0, Math.min(limit, constants.maxSharedTxs)
                ).reverse(),
                count: dependTransactions.length,
            };
        }

        const transactions = Object.values(this.pool).sort(transactionSortFunc);
        return {
            transactions: transactions.slice(0, Math.min(limit, constants.maxSharedTxs)),
            count: transactions.length,
        };
    }
}

declare class TransactionQueueScope {
    transactionPool: TransactionPool;
    transactionLogic: any;
    logger: any;
    db: any;
    network: any;
}

export class TransactionQueue {

    private queue: Array<Transaction> = [];
    private conflictedQueue: Array<{ transaction: Transaction, expire: number }> = [];

    private scope: TransactionQueueScope = {} as TransactionQueueScope;

    private locked: boolean = false;

    private accountSessions: AccountSessions = AccountSessions.getInstance();

    constructor({ transactionLogic, transactionPool, logger, db, network }: TransactionQueueScope) {
        this.scope.transactionLogic = transactionLogic;
        this.scope.transactionPool = transactionPool;
        this.scope.logger = logger;
        this.scope.db = db;
        this.scope.network = network;
    }

    lock(): void {
        this.locked = true;
    }

    unlock(): void {
        this.locked = false;
    }

    getLockStatus(): boolean {
        return this.locked;
    }

    pop(): Transaction {
        return this.queue.shift();
    }

    hasInQueue(trs: Transaction) {
        return !!this.queue.filter(transaction => transaction.id === trs.id).length;
    }

    hasInConflictedQueue(trs: Transaction) {
        return !!this.conflictedQueue.filter(obj => obj.transaction.id === trs.id).length;
    }

    has(trs: Transaction) {
        return this.hasInQueue(trs) || this.hasInConflictedQueue(trs);
    }

    push(trs: Transaction): void {
        trs.status = TransactionStatus.QUEUED;
        this.queue.push(trs);
        if (this.queue.length === 1) {
            this.process();
        } else {
            this.queue.sort(transactionSortFunc);
        }
    }

    pushInConflictedQueue(trs: Transaction): void {
        this.conflictedQueue.push({
            transaction: trs,
            expire: Math.floor(new Date().getTime() / 1000) + constants.TRANSACTION_QUEUE_EXPIRE
        });
        trs.status = TransactionStatus.QUEUED_AS_CONFLICTED;
        this.scope.logger.debug(`TransactionStatus.QUEUED_AS_CONFLICTED ${JSON.stringify(trs)}`);
    }

    // TODO can be optimized if check senderId and recipientId
    reshuffle() {
        while (this.conflictedQueue.length > 0) {
            this.push(this.conflictedQueue.pop().transaction);
        }
    }

    async process(): Promise<void> {
        if (this.queue.length === 0 || this.locked) {
            return;
        }

        const trs = this.pop();

        if (this.scope.transactionPool.has(trs)) {
            return;
        }

        if (this.scope.transactionPool.isPotentialConflict(trs)) {
            this.pushInConflictedQueue(trs);
            // notify in socket
            this.process();
            return;
        }

        const sender = await getOrCreateAccount(this.scope.db, trs.senderPublicKey);
        this.scope.logger.debug(`[TransactionQueue][process][sender] ${JSON.stringify(sender)}`);

        const verifyStatus = await this.verify(trs, sender);

        if (!verifyStatus.verified) {
            trs.status = TransactionStatus.DECLINED;
            // notify in socket
            this.process();
            return;
        }

        trs.status = TransactionStatus.VERIFIED;
        this.scope.logger.debug(`TransactionStatus.VERIFIED ${JSON.stringify(trs)}`);

        if (!this.locked) {
            const pushed = await this.scope.transactionPool.push(trs, true, false);
            if (pushed) {
                this.process();
                return;
            }
        }
        this.push(trs);
        this.process();
    }

    async verify(trs: Transaction, sender: Account): Promise<{ verified: boolean, error: Array<string> }> {

        try {
            await this.scope.transactionLogic.newVerify({ trs, sender, checkExists: true });
        } catch (e) {
            this.scope.logger.debug(`[TransactionQueue][verify]: ${e}`);
            this.scope.logger.trace(`[TransactionQueue][verify][stack]: \n ${e.stack}`);
            this.sendVerifiedMessage(sender.address, false, e.message);
            return {
                verified: false,
                error: [e]
            };
        }

        try {
            await this.scope.transactionLogic.newVerifyUnconfirmed({ trs, sender });
        } catch (e) {
            this.scope.logger.debug(`[TransactionQueue][verifyUnconfirmed]: ${e}`);
            this.scope.logger.trace(`[TransactionQueue][verifyUnconfirmed][stack]: \n ${e.stack}`);
            this.sendVerifiedMessage(sender.address, false, e.message);
            return {
                verified: false,
                error: [e]
            };
        }

        this.sendVerifiedMessage(sender.address, true);
        return {
            verified: true,
            error: []
        };
    }

    getSize(): { conflictedQueue: number, queue: number } {
        return { conflictedQueue: this.conflictedQueue.length, queue: this.queue.length };
    }

    sendVerifiedMessage(address: string, verified: boolean, error?: string) {
        this.accountSessions.send(address, 'pool/verify', {
            verified,
            error
        });
    }
}

export default TransactionPool;
