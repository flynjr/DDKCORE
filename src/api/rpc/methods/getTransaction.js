const { createServerRPCMethod, schemaValidator } = require('../util');
const ReservedError = require('../errors');
const { getTransaction } = require('../../../schema/transactions');


module.exports = createServerRPCMethod(
    'GET_TRANSACTION',

    /**
     * @param {WebSocketServer} wss
     * @param {object} params
     * @param {object} scope - Application instance
     */
    (wss, params, scope) => new Promise((resolve) => {
        if (schemaValidator(params, getTransaction)) {
            scope.modules.transactions.shared.getTransaction({ body: params }, (error, result) => {
                resolve(error
                    ? { error }
                    : result);
            });
        } else {
            return { error: ReservedError.ServerErrorInvalidMethodParameters };
        }
    }));
