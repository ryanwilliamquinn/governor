'use strict';

/*jshint expr:true, unused:false */

var Lab = require('lab'),
    lab = exports.lab = Lab.script(),
    describe = lab.describe,
    it = lab.it,
    before = lab.before,
    BPromise = require('bluebird'),
    Bunyan = require('bunyan'),
    Application = require('../lib/application'),
    socketClient = require('socket.io-client'),
    log = require('../lib/log');

function agentConnect() {
    //todo: make this port configurable
    var agenturl = 'http://localhost:8080/agent',
        agentconnection = socketClient(agenturl, {autoConnect: false});

    agentconnection.open();

    // promisify the emit... always requires an ack
    agentconnection.emitPromise = function () {
        var args = [],
            argsLength = arguments.length << 0,
            i = 0;

        for (; i < argsLength; i++) {
            args[i] = arguments[i];
        }

        return new BPromise(function (resolve) {
            args.push(function (data) {
                resolve(data);
            });
            agentconnection.emit.apply(agentconnection, args);
        });
    };

    return agentconnection;
}

/**
 * add port
 * @param count
 * @returns {*}
 */
function createServers(count) {
    var portindex = 0,
        nameindex = 0,
        proms = [],
        nodes = [],
        priority = count;

    while (portindex < count) {
        nodes.push('localhost:808' + portindex++);
    }

    while (nameindex < count) {

        proms.push(createServer({
            priority: priority--,
            nodeHostname: '127.0.0.1',
            // make this port configurable
            port: 8080 + nameindex,
            n: 'testhost' + nameindex++,
            nodes: nodes
        }));
    }

    return BPromise.all(proms);
}


function createServer(args) {

    var logger = Bunyan.createLogger({
            name: 'governor',
            streams: [{
                stream: process.stdout,
                level: Bunyan.ERROR
            }],
            serializers: log.serializers
        }),
        startupLogger = logger.child({startup: true});


    var app = new Application();
    app.setArguments(args)
        .setLogger(logger, startupLogger)
        .setNodeName(args.n);

    return app.listen().then(function () {
        logger.info('application listening');

        return BPromise.resolve()
            .delay(500)
            .then(function () {
                app.beginElection();
            })
            .catch(BPromise.CancellationError, function () {
                logger.err('already found elected master');
            })
            .then(function () {
                return app;
            });

    }).catch(function (err) {
        startupLogger.info({err: err}, 'application failed to listen');
    });
}

describe('governor', function () {

    it('should create a governor', function (done) {
        var ok = createServer({
            priority: 1,
            nodeHostname: '127.0.0.1',
            port: 8080,
            n: 'testhost1',
            nodes: ['localhost:8080']
        });

        ok = ok.then(function (app) {
            app.should.exist;
            return app.close();
        });

        ok.done(function () {
            done();
        }, done);
    });

    it('should create a couple governors', function (done) {
        var ok = createServers(2);

        ok = ok.then(function (apps) {
            apps.should.have.lengthOf(2);
            return BPromise.each(apps, function (app) {
                app.close();
            });
        });

        ok.done(function () {
            done();
        }, done);
    });

    it('should respond to send-shared-state', function (done) {

        var ok = createServers(2);

        ok = ok.delay(100); // wait a second for elections to finish

        ok = ok.then(function (apps) {
            var prom;

            apps.should.have.lengthOf(2);

            apps[0].state.isMaster.should.be.true;
            apps[1].state.isMaster.should.be.false;

            prom = apps[1].state.cluster[0].emitPromise('send-shared-state').then(function (data) {
                data.should.have.property('version', 0);
                data.should.have.property('locks');
            });

            prom = prom.then(function () {
                BPromise.each(apps, function (app) {
                    app.close();
                });
            });

            return prom.delay(1000);
        });

        ok.done(function () {
            done();
        }, done);
    });

    it('should handle cluster-place-locks to update lock state', function (done) {

        var ok = createServers(2);

        ok = ok.delay(100); // wait a second for elections to finish

        ok = ok.then(function (apps) {
            var main, backup,
                date = Date.now(),
                lockData = {agent_name: 'testagent', job_name: 'myjob', lock_data: [{key: 'testlock', locking: true}], date: date},
                agentconn = agentConnect();


            apps.should.have.lengthOf(2);

            main = apps[0];
            backup = apps[1];

            main.state.isMaster.should.be.true;
            backup.state.isMaster.should.be.false;


            var prom = agentconn.emitPromise('handle-locks', lockData, date);

            prom = prom.then(function (status) {

                main.state.shared.version = 1;
                main.state.shared.locks = {'testlock': date};

                backup.state.shared.should.have.property('version', 1);
                backup.state.shared.should.have.property('locks');
                backup.state.shared.locks.should.have.property('testlock', date);

                agentconn.close();
                return BPromise.each(apps, function (app) {
                    app.close();
                });
            });

            return prom.then(function () {
                return;
            });
        });

        ok.done(function () {
            done();
        }, done);
    });

    it('should sync if it gets out of step with master', function (done) {
        var ok = createServers(2);

        ok = ok.delay(100); // wait a bit for elections to finish

        ok = ok.then(function (apps) {
            var main, backup,
                date = Date.now(),
                lockData = {agent_name:'testagent', job_name:'myjob', lock_data: [{key: 'testlock', locking: true}], date: date},
                prom,
                agentconn = agentConnect();

            apps.should.have.lengthOf(2);

            main = apps[0];
            backup = apps[1];

            main.state.isMaster.should.be.true;
            backup.state.isMaster.should.be.false;

            main.state.shared.version = 10;
            main.state.shared.locks = {'someotherkey': date};

            // the initial state of the backup should be version 0
            backup.state.shared.should.have.property('version', 0);

            prom = agentconn.emitPromise('handle-locks', lockData, date);


            //todo: add spy to make sure the sync process is happening

            // then the sync should get fired and its version should get in sync with master
            prom = prom.then(function () {
                backup.state.shared.should.have.property('version', 11);
                backup.state.shared.should.have.property('locks');
                backup.state.shared.locks.should.have.property('someotherkey', date);
                backup.state.shared.locks.should.have.property('testlock', date);
            });

            prom = prom.then(function () {
                agentconn.close();
                BPromise.each(apps, function (app) {
                    app.close();
                });
            });

            return prom;

        });

        ok.done(function () {
            done();
        }, done);
    });

    it('should sync multiple governors', function (done) {
        var ok = createServers(5);

        ok = ok.delay(100); // wait a bit for elections to finish

        ok = ok.then(function (apps) {
            var main, backup0, backup1, backup2, backup3,
                date = Date.now(),
                lockData = {agent_name:'testagent', job_name:'myjob', lock_data: [{key: 'testlock', locking: true}], date: date},
                prom,
                agentconn = agentConnect();

            apps.should.have.lengthOf(5);

            // remove main from the apps array
            main = apps.shift();

            main.state.isMaster.should.be.true;

            apps.forEach(function (app) {
                app.state.isMaster.should.be.false;
            });

            main.state.shared.version = 10;
            main.state.shared.locks = {'someotherlock': date};

            // the initial state of the backup should be version 0
            apps.forEach(function (app) {
                app.state.shared.should.have.property('version', 0);
            });

            prom = agentconn.emitPromise('handle-locks', lockData, date);

            // the backups should sync with master
            prom = prom.then(function () {
                apps.forEach(function (app) {
                    app.state.shared.should.have.property('version', 11);
                    app.state.shared.should.have.property('locks');
                    app.state.shared.locks.should.have.property('testlock', date);
                    app.state.shared.locks.should.have.property('someotherlock', date);
                });
            });

            prom = prom.then(function () {
                main.close();
                agentconn.close();
                BPromise.each(apps, function (app) {
                    app.close();
                });
            });

            return prom;

        });

        ok.done(function () {
            done();
        }, done);
    });

    it('should track job registration', function (done) {
        var ok = createServers(2);

        ok = ok.delay(100);

        ok = ok.then(function (apps) {
            var main = apps[0],
                agentconn = agentConnect(),
                jobname = 'myjob',
                agentname = 'agent1',
                prom = agentconn.emitPromise('identify', agentname);

            main.state.isMaster.should.be.true;

            prom = prom.delay(100);

            prom = prom.then(function () {
                return agentconn.emitPromise('register-job', jobname, agentname);
            });

            return prom.then(function () {
                apps.forEach(function (app) {
                    app.state.jobs[jobname].should.have.property('active_jobs', {});
                });

                agentconn.close();
                return BPromise.each(apps, function (app) {
                    app.close();
                });
            });

        });

        ok.done(function () {
            done();
        }, done);
    });

    it('should track job activity', function (done) {
        var ok = createServers(2),
            agentname = 'agent1',
            jobname = 'myjob';

        ok = ok.delay(100);

        ok = ok.then(function (apps) {
            var main = apps[0],
                agentconn = agentConnect(),
                prom;

            main.state.isMaster.should.be.true;

            prom = agentconn.emitPromise('identify', agentname);

            prom = prom.then(function () {
                return agentconn.emitPromise('register-job', jobname, agentname);
            });

            prom = prom.then(function () {
                apps.forEach(function (app) {
                    app.state.jobs[jobname].should.have.property('active_jobs', {});
                    app.state.agents[agentname].jobs.should.have.property(jobname);
                });
            });

            prom = prom.then(function () {
                return agentconn.emitPromise('job-start', jobname, agentname);
            });


            //prom = prom.then(function () {
            //
            //});

            prom = prom.then(function () {
                console.log('closing stuff');
                agentconn.close();
                return BPromise.each(apps, function (app) {
                    app.close();
                });
            });

            return prom;
        });

        ok.done(function () {
            done();
        }, done);
    });

});
