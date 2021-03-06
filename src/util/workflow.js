

// --

function Workflow(that, logger, topic, cargs) {
    this.that = that;
    this.logger = logger;
    this.topic = topic;
    this.steps = [];
    this.cargs = cargs || [];

    this.callback = null;
    this.currStep = null;

    this.nextStep = this.nextStep.bind(this);
    this.inCallback = false;
}

Workflow.prototype.pushStep = function (topic, callback) {
    this.steps.push([ topic, callback ]);
}

Workflow.prototype.unshiftStep = function (topic, callback) {
    this.steps.unshift([ topic, callback ]);
}

Workflow.prototype.nextStep = function (error, result) {
    var that = this;

    if (this.currStep) {
        this.logger.verbose(
            this.currStepTopic,
            (error ? 'failure' : 'success')
        );

        if (error) {
            this.callback(error);

            return;
        }

        this.currStep = null;
        process.nextTick(
            function () {
                that.nextStep();
            }
        );

        return;
    }

    this.currStep = this.steps.shift();

    if (!this.currStep) {
        this.callback(null, true);

        return;
    }

    this.currStepTopic = this.topic + '/' + this.currStep[0];

    this.logger.verbose(
        this.currStepTopic,
        'running...'
    );

    try {
        var args = [ this, this.nextStep ];
        args.push.apply(args, this.cargs);

        this.currStep[1].apply(this.that, args);
    } catch (e1) {
        if (!this.inCallback) {
            this.nextStep(e1);

            return;
        }

        throw e1;
    }
}

Workflow.prototype.run = function (callback) {
    var that = this;

    this.logger.verbose(
        this.topic,
        'running...'
    );

    this.callback = function (error, result) {
        that.inCallback = true;

        this.logger.verbose(
            this.topic,
            error ? 'failure' : 'success'
        );

        callback(error, result);

        that.inCallback = false;
    }

    this.nextStep();
}

// --

module.exports = Workflow;
