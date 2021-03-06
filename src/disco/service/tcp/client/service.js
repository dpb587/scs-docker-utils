var net = require('net');
var uuid = require('node-uuid');
var Socket = require('../socket');
var Session = require('../../../registry/session');
var UtilCommands = require('../../common/util-commands');

function Service(options, logger) {
    var options = options || {};

    options.server = options.server || {};
    options.server.address = 'address' in options.server ? options.server.address : '127.0.0.1';
    options.server.port = 'port' in options.server ? options.server.port : '9640';

    options.join = options.join || {};
    options.join.timeout = 30000;

    options.join.rejoin = 'rejoin' in options.join ? options.join.rejoin : true;

    options.environment = options.environment || 'default';
    options.service = options.service || 'default';
    options.role = options.role || 'default';

    this.options = options;

    this.logger = logger;

    this.activeLocal = false;
    this.activeRemote = false;

    this.session = new Session(null, {}, logger);
    this.session.id = 'anonymous';

    this.socket = null;

    this.reconnectBackoff = 0;
    this.reconnectTimer = null;

    this.provisionHandles = {};
    this.requirementHandles = {};

    this.commands = UtilCommands.mergeCommandSets(
        [
            require('./commands')
        ]
    );
}

Service.prototype.addProvision = function (endpoint, address, options) {
    var lid = uuid.v4();

    var options = options || {};
    options.environment = options.environment || this.options.environment;
    options.service = options.service || this.options.service;
    options.role = options.role || this.options.role;

    this.provisionHandles[lid] = {
        activeLocal : true,
        activeRemote : false,
        params : {
            environment : options.environment,
            service : options.service,
            role : options.role,
            endpoint : endpoint,
            address : address,
            attributes : options.attributes || null
        }
    };

    this.sendProvision(lid);

    return lid;
}

Service.prototype.sendProvision = function (lid) {
    var that = this;

    this.session.sendCommand(
        'provision.add',
        this.provisionHandles[lid].params,
        function (error, result) {
            if (null !== error) {
                that.logger.error('provision', error);

                return;
            }

            that.provisionHandles[lid].handle = result.id;
            that.provisionHandles[lid].activeRemote = true;
        }
    );
}

Service.prototype.addRequirement = function (endpoint, options, callback) {
    if ('function' == typeof options) {
        callback = options;
        options = {};
    }

    var lid = uuid.v4();

    var options = options || {};
    options.environment = options.environment || this.options.environment;
    options.service = options.service || this.options.service;
    options.role = options.role || this.options.role;

    this.requirementHandles[lid] = {
        callback : callback,
        endpoints : null,
        activeLocal : true,
        activeRemote : false,
        params : {
            environment : options.environment,
            service : options.service,
            role : options.role,
            endpoint : endpoint,
            attributes : options.attributes || null
        }
    };

    this.sendRequirement(lid);

    return lid;
}

Service.prototype.sendRequirement = function (lid) {
    var that = this;

    this.session.sendCommand(
        'requirement.add',
        that.requirementHandles[lid].params,
        function (error, result) {
            if (null !== error) {
                that.logger.error('requirement', error)

                return;
            }

            that.requirementHandles[lid].endpoints = result.endpoints;
            that.requirementHandles[lid].handle = result.id;
            that.requirementHandles[lid].activeRemote = true;
            that.requirementHandles[lid].callback('initial', result.endpoints, function () {});
        }
    );

    return lid;
}

Service.prototype.dropProvision = function (id, wait, callback) {
    var that = this;

    this.provisionHandles[id].activeLocal = false;

    this.session.sendCommand(
        'provision.drop',
        {
            id : this.provisionHandles[id].handle,
            wait : wait
        },
        function (error, result) {
            if (!error) {
                delete that.provisionHandles[id];
            }

            callback(error, result);
        }
    );
}

Service.prototype.dropRequirement = function (id, callback) {
    var that = this;

    this.requirementHandles[id].activeLocal = false;

    this.session.sendCommand(
        'requirement.drop',
        {
            id : this.requirementHandles[id].handle
        },
        function (error, result) {
            if (!error) {
                delete that.requirementHandles[id];
            }

            callback(error, result);
        }
    );
}

Service.prototype.reconnect = function () {
    var that = this;

    if (this.socket) {
        this.socket.end();

        return;
    }

    this.socket = new Socket(
        this,
        new net.createConnection({
            host : this.options.server.address,
            port : this.options.server.port
        }),
        this,
        null,
        this.logger
    );

    this.socket.raw.on('connect', function () {
        that.logger.verbose('client', 'connected');

        that.reconnectBackoff = 0;

        if ('anonymous' != that.session.id) {
            that.socket.sendSocketCommand(
                'session.attach',
                { 'id' : that.session.id },
                function (error, result) {
                    if (error) {
                        that.logger.error('client/session.attach', error);

                        process.nextTick(
                            function () {
                                that.session.id = 'anonymous';
                                that.reconnect();
                            }
                        );

                        that.socket.end();

                        return;
                    }

                    that.socket.setSession(that.session);

                    that.logger.verbose('client', 'rejoined existing session');

                    that.activeRemote = true;
                }
            );
        } else {
            that.socket.sendSocketCommand(
                'registry.join',
                {},
                function (error, result) {
                    if (error) {
                        that.logger.error('client/registry.join', error);

                        return;
                    }

                    that.session.id = result.id;
                    that.session.attach(that.socket);
                    that.socket.setSession(that.session);

                    that.logger.verbose('client', 'joined new session (' + that.session.id + ')');

                    that.activeRemote = true;

                    Object.keys(that.provisionHandles).forEach(
                        function (lid) {
                            if (true == that.provisionHandles[lid].activeRemote) {
                                that.sendProvision(lid);
                            }
                        }
                    );

                    Object.keys(that.requirementHandles).forEach(
                        function (lid) {
                            if (true == that.requirementHandles[lid].activeRemote) {
                                that.sendRequirement(lid);
                            }
                        }
                    );
                }
            );
        }
    });
    this.socket.raw.on('error', function (error) {
        that.logger.error(
            'client/error',
            error.name + ':' + error.message
        );
        that.logger.info(
            'client/error',
            error.stack
        );
    });
    this.socket.raw.on('close', function (had_error) {
        that.socket = null;

        if (that.activeLocal) {
            that.logger.silly('client', 'reconnecting in ' + that.reconnectBackoff + ' seconds...');

            that.reconnectTimer = setTimeout(
                function () {
                    that.reconnectBackoff += 10;
                    that.reconnect();
                },
                that.reconnectBackoff * 1000
            );
        }
    });

    this.logger.silly('client', 'connecting...');
};

Service.prototype.start = function (callback) {
    this.activeLocal = true;

    this.reconnect();
};

Service.prototype.stop = function (callback) {
    var that = this;

    if (callback) {
        this.server.on('close', callback);
    }

    if (true == this.activeLocal) {
        this.activeLocal = false;

        clearTimeout(this.reconnectTimer);
        this.reconnectBackoff = 0;

        this.logger.silly('client', 'stopping...');

        var readyDoneCount = 1;

        function readyDone() {
            readyDoneCount -= 1;

            if (0 < readyDoneCount) {
                return;
            }

            if (true == that.activeRemote) {
                that.session.sendCommand(
                    'registry.leave',
                    null,
                    function () {
                        that.socket.end();
                    }
                );
            } else {
                that.socket.end();
            }
        }


        Object.keys(that.provisionHandles).forEach(
            function (lid) {
                if (true == that.provisionHandles[lid].activeRemote) {
                    readyDoneCount += 1;

                    that.dropProvision(
                        lid,
                        readyDone
                    );
                }
            }
        );

        Object.keys(that.requirementHandles).forEach(
            function (lid) {
                if (true == that.requirementHandles[lid].activeRemote) {
                    readyDoneCount += 1;

                    that.dropRequirement(
                        lid,
                        readyDone
                    );
                }
            }
        );

        readyDone();
    } else {
        this.socket.end();
    }
}

module.exports = Service;
