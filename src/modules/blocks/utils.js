/**
 * Initializes library.
 * @memberof module:blocks
 * @class
 * @classdesc Main Utils logic.
 * Allows utils functions for blocks.
 * @param {Object} logger
 * @param {Block} block
 * @param {Transaction} transaction
 * @param {Database} db
 * @param {Sequence} dbSequence
 * @param {Object} genesisblock
 */
const { transactionSortFunc } = require('src/helpers/transaction.utils');

const _ = require('lodash');
const constants = require('../../helpers/constants.js');
const sql = require('../../sql/blocks.js');
const Rounds = require('../rounds.js');

let modules;
let library;
let self;
const __private = {};

function Utils(logger, block, transaction, db, dbSequence, genesisblock) {
    library = {
        logger,
        db,
        dbSequence,
        genesisblock,
        logic: {
            block,
            transaction,
        },
    };
    self = this;

    library.logger.trace('Blocks->Utils: Submodule initialized.');
    return self;
}

/**
 * Normalize blocks and their transactions
 * // FIXME: Looks like that function can accepts both blocks and transactions as param, processing here is not clear
 *
 * @private
 * @method readDbRows
 * @param  {Object} rows List of blocks/transactions?
 * @return {Object} blocks Normalized list of blocks with transactions
 */
Utils.prototype.readDbRows = function (rows) {
    let blocks = {};
    const order = [];

    for (let i = 0, length = rows.length; i < length; i++) {
        // Normalize block
        // FIXME: Can have poor performance because it performs SHA256 hash calculation for each block
        const block = library.logic.block.dbRead(rows[i]);

        if (block) {
            // If block is not already in the list...
            if (!blocks[block.id]) {
                if (block.id === library.genesisblock.block.id) {
                    // Generate fake signature for genesis block
                    block.generationSignature = (new Array(65)).join('0');
                }

                // Add block ID to order list
                order.push(block.id);
                // Add block to list
                blocks[block.id] = block;
            }

            // Normalize transaction
            const transaction = library.logic.transaction.dbRead(rows[i]);
            // Set empty object if there are no transactions in block
            blocks[block.id].transactions = blocks[block.id].transactions || {};

            if (transaction) {
                // Add transaction to block if not there already
                if (!blocks[block.id].transactions[transaction.id]) {
                    blocks[block.id].transactions[transaction.id] = transaction;
                }
            }
        }
    }

    // Reorganize list
    blocks = order.map((v) => {
        blocks[v].transactions = Object.keys(blocks[v].transactions)
        .map(t => blocks[v].transactions[t]);
        return blocks[v];
    });

    return blocks;
};

/**
 * Loads full blocks from database and normalize them
 *
 * @async
 * @public
 * @method loadBlocksPart
 * @param  {Object}   filter Filter options
 * @param  {Object}   filter.limit Limit blocks to amount
 * @param  {Object}   filter.lastId ID of block to begin with
 * @param  {Function} cb Callback function
 * @return {Function} cb Callback function from params (through setImmediate)
 * @return {Object}   cb.err Error if occurred
 * @return {Object}   cb.rows List of normalized blocks
 */
Utils.prototype.loadBlocksPart = function (previousBlockId, cb) {
    library.logger.debug(`[Utils][loadBlocksPart]' previousBlockId: ${previousBlockId}`);
    library.db.manyOrNone(sql.loadFullBlockById, { id: previousBlockId })
    .then((previousBlockRaw) => {
        if (previousBlockRaw && previousBlockRaw.length !== 0) {
            const previousBlock = self.readDbRows(previousBlockRaw)[0];
            return setImmediate(cb, null, previousBlock);
        }
        return setImmediate(cb, 'previousBlock is null');
    });
};

/**
 * Loads full normalized last block from database
 * see: loader.loadBlockChain (private)
 *
 * @async
 * @public
 * @method loadLastBlock
 * @param  {Function} cb Callback function
 * @return {Function} cb Callback function from params (through setImmediate)
 * @return {Object}   cb.err Error message if error occurred
 * @return {Object}   cb.block Full normalized last block
 */
Utils.prototype.loadLastBlock = function (cb) {
    library.dbSequence.add((cbAdd) => {
        // Get full last block from database
        // FIXME: Ordering in that SQL - to rewrite
        library.db.query(sql.loadLastBlock)
        .then((rows) => {
            // Normalize block
            const block = modules.blocks.utils.readDbRows(rows)[0];

            // Sort block's transactions
            block.transactions = block.transactions.sort(transactionSortFunc);

            // Update last block
            modules.blocks.lastBlock.set(block);
            return setImmediate(cbAdd, null, block);
        })
        .catch((err) => {
            library.logger.error(err.stack);
            return setImmediate(cbAdd, 'Blocks#loadLastBlock error');
        });
    }, cb);
};

/**
 * Get blocks IDs sequence - last block ID, IDs of first blocks of last 5 rounds, genesis block ID
 *
 * @private
 * @async
 * @method getIdSequence
 * @param  {number}   height Block height
 * @param  {Function} cb Callback function
 * @return {Function} cb Callback function from params (through setImmediate)
 * @return {Object}   cb.err Error if occurred
 * @return {Object}   cb.res Result
 * @return {string}   cb.res.firstHeight Height of last block
 * @return {string}   cb.res.ids Comma separated list of blocks IDs
 */
Utils.prototype.getIdSequence = function (height, cb) {
    const lastBlock = modules.blocks.lastBlock.get();
    // Get IDs of first blocks of (n) last rounds, descending order
    // EXAMPLE: For height 2000000 (round 19802)
    // we will get IDs of blocks at height: 1999902, 1999801, 1999700, 1999599, 1999498
    library.db.query(
        sql.getIdSequence(),
        { height, limit: 5, delegates: Rounds.prototype.getSlotDelegatesCount(height) }
    )
    .then((rows) => {
        if (rows.length === 0) {
            return setImmediate(cb, `Failed to get id sequence for height: ${height}`);
        }

        const ids = [];

        // Add genesis block at the end if the set doesn't contain it already
        if (library.genesisblock && library.genesisblock.block) {
            const __genesisblock = {
                id: library.genesisblock.block.id,
                height: library.genesisblock.block.height
            };

            if (!_.includes(rows, __genesisblock.id)) {
                rows.push(__genesisblock);
            }
        }

        // Add last block at the beginning if the set doesn't contain it already
        if (lastBlock && !_.includes(rows, lastBlock.id)) {
            rows.unshift({
                id: lastBlock.id,
                height: lastBlock.height
            });
        }

        // Extract blocks IDs
        rows.forEach((row) => {
            // FIXME: Looks like double check
            if (!_.includes(ids, row.id)) {
                ids.push(row.id);
            }
        });

        return setImmediate(cb, null, { firstHeight: rows[0].height, ids: ids.join(',') });
    })
    .catch((err) => {
        library.logger.error(err.stack);
        return setImmediate(cb, 'Blocks#getIdSequence error');
    });
};

/**
 * Load full block with a particular height
 *
 * @param {number} height - Block height
 * @param {function} cb - Callback function
 * @param {object} tx - Database transaction object
 * @returns {function} cb - Callback function from params (through setImmediate)
 * @returns {Object} cb.err - Error if occurred
 * @returns {Object} cb.block - Block with requested height
 */
Utils.prototype.loadBlockByHeight = function (height, cb) {
    library.db.query(sql.loadBlocksOffset, [height, height + 1])
    .then((rows) => {
        const blocks = self.readDbRows(rows);
        return setImmediate(cb, null, blocks[0]);
    })
    .catch((err) => {
        library.logger.error(err.stack);
        return setImmediate(cb, 'Blocks#loadBlockByHeight error');
    });
};

/**
 * Generates a list of full blocks for another node upon sync request from that node
 * see: modules.transport.internal.blocks
 *
 * @async
 * @public
 * @method loadBlocksData
 * @param  {Object}   filter Filter options
 * @param  {Object}   filter.limit Limit blocks to amount
 * @param  {Object}   filter.lastId ID of block to begin with
 * @param  {Function} cb Callback function
 * @return {Function} cb Callback function from params (through setImmediate)
 * @return {Object}   cb.err Error if occurred
 * @return {Object}   cb.rows List of blocks
 */
Utils.prototype.loadBlocksData = function (filter, options, cb) {
    // FIXME: options is not used
    if (arguments.length < 3) {
        cb = options;
        options = {};
    }

    options = options || {};

    const params = { limit: filter.limit || 1 };

    // FIXME: filter.id is not used
    if (filter.id && filter.lastId) {
        return setImmediate(cb, 'Invalid filter: Received both id and lastId');
    } else if (filter.id) {
        params.id = filter.id;
    } else if (filter.lastId) {
        params.lastId = filter.lastId;
    }

    // Execute in sequence via dbSequence
    library.dbSequence.add((cbAdd) => {
        // Get height of block with supplied ID
        library.db.query(sql.getHeightByLastId, { lastId: filter.lastId })
        .then((rows) => {
            if (!rows || !rows.length) {
                return setImmediate(cbAdd, `Block with id: ${filter.lastId} is missing`);
            }
            const height = rows.length ? rows[0].height : 0;
            // Calculate max block height for database query
            const realLimit = height + (parseInt(filter.limit, 10) || 1);

            params.limit = realLimit;
            params.height = height;

            // Retrieve blocks from database
            // FIXME: That SQL query have mess logic, need to be refactored
            library.db.query(sql.loadBlocksData(filter), params)
            .then(rowsBlock => setImmediate(cbAdd, null, rowsBlock));
        })
        .catch((err) => {
            library.logger.error(err.stack);
            return setImmediate(cbAdd, 'Blocks#loadBlockData error');
        });
    }, cb);
};

/**
 * Creates logger for tracking applied transactions of block
 *
 * @method getBlockProgressLogger
 * @param  {number} transactionsCount
 * @param  {number} logsFrequency
 * @param  {string} msg
 * @return {BlockProgressLogger}
 */
Utils.prototype.getBlockProgressLogger = function (transactionsCount, logsFrequency, msg) {
    function BlockProgressLogger(blockTransactionCount, blockBlogsFrequency, msgBlock) {
        this.target = blockTransactionCount;
        this.step = Math.floor(blockTransactionCount / blockBlogsFrequency);
        this.applied = 0;

        /**
         * Resets applied transactions
         */
        this.reset = function () {
            this.applied = 0;
        };

        /**
         * Increments applied transactions and logs the progress
         * - For the first and last transaction
         * - With given frequency
         */
        this.applyNext = function () {
            if (this.applied >= this.target) {
                throw new Error(`Cannot apply transaction over the limit: ${this.target}`);
            }
            this.applied += 1;
            if (this.applied === 1 || this.applied === this.target || this.applied % this.step === 1) {
                this.log();
            }
        };

        /**
         * Logs the progress
         */
        this.log = function () {
            library.logger.info(msgBlock, `${((this.applied / this.target) * 100)
            .toPrecision(4)} % : applied ${this.applied} of ${this.target} transactions`);
        };
    }

    return new BlockProgressLogger(transactionsCount, logsFrequency, msg);
};

/**
 * Get block rewards of delegate for time period
 *
 * @public
 * @async
 * @method aggregateBlocksReward
 * @param  {Object}   filter ID of block to begin with
 * @param  {string}   filter.generatorPublicKey Delegate public key
 * @param  {number}   [filter.start] Start timestamp
 * @param  {number}   [filter.end] End timestamp
 * @param  {Function} cb Callback function
 * @return {Function} cb Callback function from params (through setImmediate)
 * @return {Object}   cb.err Error if occurred
 * @return {Object}   cb.data Rewards data
 * @return {number}   cb.data.fees Round fees
 * @return {number}   cb.data.rewards Blocks rewards
 * @return {number}   cb.data.count Blocks count
 */
Utils.prototype.aggregateBlocksReward = function (filter, cb) {
    const params = {};

    params.generatorPublicKey = filter.generatorPublicKey;
    params.delegates = constants.activeDelegates;

    if (filter.start !== undefined) {
        params.start = filter.start - (constants.epochTime.getTime() / 1000);
    }

    if (filter.end !== undefined) {
        params.end = filter.end - (constants.epochTime.getTime() / 1000);
    }

    // Get calculated rewards
    library.db.query(sql.aggregateBlocksReward(params), params)
    .then((rows) => {
        let data = rows[0];
        if (data.delegate === null) {
            return setImmediate(cb, 'Account not found or is not a delegate');
        }
        data = { fees: data.fees || '0', rewards: data.rewards || '0', count: data.count || '0' };
        return setImmediate(cb, null, data);
    })
    .catch((err) => {
        library.logger.error(err.stack);
        return setImmediate(cb, 'Blocks#aggregateBlocksReward error');
    });
};

/**
 * Handle modules initialization:
 * - blocks
 * @param {modules} scope Exposed modules
 */
Utils.prototype.onBind = function (scope) {
    library.logger.trace('Blocks->Utils: Shared modules bind.');
    modules = {
        blocks: scope.blocks
    };

    // Set module as loaded
    __private.loaded = true;
};

module.exports = Utils;

/** ************************************* END OF FILE ************************************ */
