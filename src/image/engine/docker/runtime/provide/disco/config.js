var util = require('util');
var ConfigBase = require('../../../../../../config/config');

// --

function Config() {
    ConfigBase.apply(this, arguments);
}

util.inherits(Config, ConfigBase);

Config.prototype.setDefaults = function () {
    this.set('server.address', '127.0.0.1');
    this.set('server.port', '9640');
}

// --

module.exports = Config;