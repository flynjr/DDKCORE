const httpApi = require('./httpApi');
const extend = require('extend');
const utils = require('../utils.js');

/**
 * Express.js router wrapper.
 * @memberof module:helpers
 * @function
 * @returns {Object} router express
 * @throws {Error} If config is invalid
 */
const Router = function () {
    const router = require('express').Router();

    router.use(httpApi.middleware.cors);

    router.map = function (root, config) {
        const router = this;

        Object.keys(config).forEach((params) => {
            const route = params.split(' ');
            if (route.length !== 2 || ['post', 'get', 'put'].indexOf(route[0]) === -1) {
                throw Error('Invalid map config');
            }
            // made changes to add session data and res object to the req object that is accessible in modules
            router[route[0]](route[1], utils.validateClient, (req, res, next) => {
                const reqRelevantInfo = {
                    ip: req.ip,
                    host: req.get('host'),
                    protocol: req.protocol,
                    method: req.method,
                    path: req.path,
                    decoded: req.decoded
                };
                root[config[params]](extend({}, reqRelevantInfo, res, { body: route[0] === 'get' ? req.query : req.body }), httpApi.respond.bind(null, res));
            });
        });
    };
    /**
     * Adds one middleware to an array of routes.
     * @param {Function} middleware
     * @param {String} routes
     */
    router.attachMiddlwareForUrls = function (middleware, routes) {
        routes.forEach((entry) => {
            const route = entry.split(' ');

            if (route.length !== 2 || ['post', 'get', 'put'].indexOf(route[0]) === -1) {
                throw Error('Invalid map config');
            }
            router[route[0]](route[1], middleware);
        });
    };

    return router;
};

module.exports = Router;

/** ************************************* END OF FILE ************************************ */
