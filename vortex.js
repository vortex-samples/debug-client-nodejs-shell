/********************************************************************************************
 * This program demonstrates how you can poll Vortex for replay events and process them.
 * The sample contains 3 main code files
 *     start.js     - manages program flow an handles user input
 *     vortex.js    - methods for working with Vortex.
 *     replay.js    - methods for replaying an HTTP call locally.
 *
 * In this sample the term Interception refers to any item found in the journal at www.vtxhub.com
 * Interceptions may happen in real-time while this debugger is running or later by clicking
 *     the replay button at the top of the journal detail dialog online.
 *
 * What you can expect to see here...
 * 1. The program will authenticate the current user to get an access_token for working with Vortex
 * 2. A polling loop will be started to check Vortex for new journal entries needing replay on the local machine.
 * 3. New journal entries will me accepted so they do not get processed anywhere else
 * 3. Replay items will have their url re-written and a new HTTP request will be made on the local machine.
 * 4. The resulting HTTP status and data will be updated and its journal status set to reply so it is not processed again.
 */

let dateTime = function (){ return Date().split('GM')[0]; }

const VERSION = '1.1.7',
    ASK_FOR_SITE = 'select site',
    ASK_FOR_HOST = 'select host',
    ASK_FOR_PORT = 'select port',
    ASK_FOR_PROVIDER = 'select provider',
    ASK_OLD_PIN = 'old pin',
    ASK_NEW_PIN = 'new pin',
    ASK_NEW_VERSION = 'new version',
    ASK_CREDENTIALS = 'credentials';

function myParseInt(value, dummyPrevious) {
    return parseInt(value);
}

function myParseProvider(value, dummyPrevious) {
    if (!value) return 'http';
    if (value.toLowerCase() === 'http') return 'http';
    else return 'https';
}

function myParseHost(value, dummyPrevious) {
    return value ? value.toLowerCase() : '';
}

function nothing() {
}

function disconnected() {
    say('Network error! Goodbye', true);
}

function exception(e) {
    say('error: '.red + 'something went wrong!');
    say(e);
}

let api = require('./vortex-api.js'),   // vortex helper
    portal = require('./portal.js'),    // web portal helper
    replay = require('./replay.js'),    // local reply helper
    secure = '.vortex.aes',             // local secure data store
    fs = require('fs'),                 // nodejs filesystem helper (internal)
    aes256 = require('./aes256.js'),    // local cryptography helper
    prompt = require('prompt'),         // https://www.npmjs.com/package/prompt
    colors = require('colors'),         // https://www.npmjs.com/package/colors
    commander = require('commander'),   // https://www.npmjs.com/package/commander
    _this = this;                       // js lexical closure
_this.COUNT_ERRORS = 0;
_this.COUNT_REPLAYS = 0;
_this.stats = {};
_this.QUEUE_CURRENT = 0;
_this.QUEUE_MAX = 0;

replay.onLog(function(what) {
    if (typeof what === 'string') console.log(what.red);
    else console.log(what);
})

// Polling Behavior
// Sliding value based upon if there are interceptions to process
// When there are no interceptions, then it will increment to a longer polling interval
// When there are interceptions, it will immediately use the minimum polling interval
var POLLING_INTERVAL = 50;                  // initial start value of 50ms
var POLLING_FAULT = false;                  // indicates if a polling fault happened
//sliding range for polling interval.
const POLLING_INTERVAL_MIN = 50             // no sooner than this value in ms
const POLLING_INTERVAL_MAX = 2000           // no later than this value in ms
const POLLING_INTERVAL_STEP = 50            // add this much to the delay when there are no interceptions

//range and step for delayed polling intervals
const POLLING_INTERVAL_DELAYED_MAX = 15000  // up to 15 sec when there are errors
const POLLING_INTERVAL_DELAYED_STEP = 5000  // increment up to 5 sec at a time
const POLLING_INTERVAL_PAUSED = 2500        // value to use when paused

var params = new commander.Command()  // setup the params syntax
    .version(VERSION)
    .option('--host <host>', 'Local forward host', myParseHost,)
    .option('--port <port>', 'Local forward port', myParseInt,)
    .option('--provider <provider>', 'Local debug provider', myParseProvider)
    .option('--env <env>', 'Environment for Vortex Hub development purposes')
    .option('-d, --defaultlocal', 'Skip prompts, use default http://127.0.0.1:8080')
    .option('--save', 'Save sign in with PIN code')
    .option('-s, --site <site>', 'Site to debug')
    .option('--verifytls', "Verify forwarding host's certificate (not required for local dev)")
    .option('--email <email>', 'Account email address')
    .option('--password <password>', 'Account password')
    .option('--appliance <url>', 'URL to a Vortex Hub appliance, e.g. https://vtxappliance.yourcompany.com');

/****
 * Graceful shutdown for the app
 * @param exitCode Exit code to supply the console
 */
function exit(exitCode) {
    say(exitCode, true);
}

/**
 * Say something meaningful to the user
 * @param what Keyword to pick phrase to say
 * @param shutdown Boolean to indicate of the app should shut down
 * @param writer optional function used to write text output
 */
function say(what, shutdown, writer) {
    if (!writer) writer = console.log;

    what = what || ''; // sanity check
    switch (what) {
        case ASK_NEW_VERSION:
            writer('*************************************************'.green)
            writer('*'.green + '  NEW VERSION AVAILABLE                        ' + '*'.green)
            writer('*'.green + '  CURRENT: ' + VERSION + '                               ' + '*'.green)
            writer('*'.green + '  LATEST:  ' + _this.VERSION_LATEST + '                               ' + '*'.green)
            writer('*************************************************'.green)
            writer('')
            writer('Download the latest version at ' + _this.VORTEX_WWW_SERVER + '/#/app/expose')
            writer('')
            break;
        // detailed status information
        case 'status':
            writer(
                (_this.paused ? 'Connection'.yellow : 'Connection'.green) +
                '          ' +
                (_this.paused ? 'Paused'.yellow : 'Active'.green));
            writer('Account'.padEnd(20) + _this.VORTEX_USER);
            writer('Forwarding'.padEnd(20) + 'http://' + params.site + ' -> ' + params.provider + '://' + params.host + ':' + params.port);
            writer('Forwarding'.padEnd(20) + 'https://' + params.site + ' -> ' + params.provider + '://' + params.host + ':' + params.port);
            writer('Verify TLS'.padEnd(20) + (!params.verifytls ? 'off ' + 'to support self-signed SSL certificates'.dim : 'on'));
            writer('Shell Version'.padEnd(20) + VERSION);
            break;
        case 'counters':

            writer('Forwarding Counters'.padEnd(20) +
                'Total'.padEnd(10) +
                'Pass'.padEnd(10) +
                'Fail'.padEnd(10) +
                'Queued'.padEnd(10) +
                'Max Queue'.padEnd(10));
            writer(' '.padEnd(20) +
                (_this.COUNT_REPLAYS + _this.COUNT_ERRORS).toString().padEnd(10) +
                (_this.COUNT_REPLAYS).toString().padEnd(10) +
                (_this.COUNT_ERRORS).toString().padEnd(10) +
                (_this.QUEUE_CURRENT).toString().padEnd(10) +
                (_this.QUEUE_MAX).toString().padEnd(10));
            break;

        case 'forwarding':
            say('Forwarding ' + params.site + ' -> ' + params.provider + '://' + params.host + ':' + params.port);
            break;

        default:
            writer(what);
    }
    if (shutdown) process.exit();
}

/*****
 * Configure the app using command line values supplied
 */
function configure() {
    params.parse(process.argv)

    // default to not not verifying forwarding host's cert (default to dev env)
    if (!params.enabletls) params.enabletls = false;


    //standardize appliance parameter if it exists
    params.appliance = !params.appliance ?'':params.appliance.toLowerCase();

    //if there isn't an appliance passed then default to the cloud service or development environment
    if (!params.appliance) {
        params.env = !params.env ? '' : params.env.toLowerCase();

        //use development or production values by default
        switch (params.env) {
            case 'local':
                console.log("Using ENV:" + params.env);
                _this.VORTEX_API_SERVER = 'http://localhost:8081/v1';
                _this.VORTEX_WWW_SERVER = 'http://localhost:8080';
                break;
            case 'devbox':
                console.log("Using ENV:" + params.env);
                _this.VORTEX_API_SERVER = 'http://www.vortexhub.vtx/v1';
                _this.VORTEX_WWW_SERVER = 'http://www.vortexhub.vtx';
                break;
            default:
                _this.VORTEX_API_SERVER = 'https://api.vtxhub.com/v1';
                _this.VORTEX_WWW_SERVER = 'https://www.vtxhub.com';
                break;
        }
    }else{
        //use the vortex hub appliance value if passed
        if (params.appliance.startsWith('http://') || params.appliance.startsWith('https://')){
            console.log("Using Appliance: " + params.appliance);
            _this.VORTEX_WWW_SERVER = params.appliance;

            //if cloud service connection then api path is not like the typical appliance
            if (params.appliance === 'https://www.vtxhub.com'){
                _this.VORTEX_API_SERVER = 'https://api.vtxhub.com/v1';
            }else {
                //appliance API is the url with /v1
                _this.VORTEX_API_SERVER = params.appliance + '/v1';
            }
        }else{
            console.log("Appliance must start with http:// or https://")
            process.exit(1);
        }
    }
}

/*****
 * Ask for a input parameter or choose the default value (override using startup params)
 */
function askIfMissing(what, override) {
    return new Promise(function (success, failure) {
        switch (what) {
            case ASK_FOR_SITE:
                if(params.site) {

                    // user didn't pass in a FQDN for the site so build the FQDN
                    if(!String(params.site).includes(".")) { 
                        if (_this.VORTEX_WWW_SERVER === 'https://www.vtxhub.com') {
                            params.site += ".app.vtxhub.com"; // cloud service instant domains starts with app.vtxhub.com
                        }else if (_this.VORTEX_WWW_SERVER.includes('www.vortexhub.vtx')){
                            params.site += ".app.vortexhub.vtx"; // vortex development environment
                        }else{
                            params.site += '.' + _this.VORTEX_WWW_SERVER.split('://')[1]; // append the the site with the url
                        }
                    }

                    //make sure the user passed in a site that exists in their account
                    if(!_this.VORTEX_USER_WEBAPPS.find(s => s.host === params.site)) {
                        say(`Site not found in Vortex Hub: ${params.site}`);
                        failure;
                    }
                }

                if (params.site && !override) {
                    api.webapp(params.site).then(function (valid_site) {
                        params.site = valid_site.host;
                        success(params.site);
                    }, failure)
                } else {
                    ask(what, function (site) {
                        if (!site) site = override || _this.VORTEX_USER_WEBAPPS[0].host;
                        api.webapp(site).then(function (valid_site) {
                            params.site = valid_site.host;
                            success(params.site);
                        }, failure);
                    });
                }
                break;
            case ASK_FOR_HOST:

                params.host && !override ? success(params.host) : ask(what, function (value) {
                    if (!value) value = override || '127.0.0.1';
                    success(value);
                });
                break;
            case ASK_FOR_PORT:
                params.port && !override ? success(params.port) : ask(what, function (value) {
                    if (!value) value = parseInt(override) || 8080;
                    success(value);
                });
                break;
            case ASK_FOR_PROVIDER:
                params.provider && !override ? success(params.provider) : ask(what, function (value) {
                    if (!value) value = override || 'http';
                    success(value);
                });
                break;
            default:
                failure();
        }
    });
}

/*****
 * Remember a users authentication data, stored securely with a pin code
 */
function remember(token, callback) {
    if (params.save && !_this.resumed) {
        ask(ASK_NEW_PIN, function (pin) {
            let e = aes256.encrypt(JSON.stringify(token), pin);
            fs.writeFileSync((params.env ? '-' + params.env : '') + secure, JSON.stringify(e), 'utf8');
            callback();
        })
    } else {
        callback();
    }
}

/*****
 * Called after a user is successfully authenticated
 */
function authenticated(token) {
    _this.VORTEX_USER = token.client_id;
    _this.paused = false;

    // save the users credentials if they asked for it
    remember(token, function () {
        api.webapps().then(function (webapps) {
            _this.VORTEX_USER_WEBAPPS = webapps;
            askIfMissing(ASK_FOR_SITE).then((site) => {
                askIfMissing(ASK_FOR_HOST).then((host) => {
                    askIfMissing(ASK_FOR_PORT).then((port) => {
                        askIfMissing(ASK_FOR_PROVIDER).then((provider) => {
                            say('status');
                            waitNextPoll(0);
                            input(exit);
                        }, disconnected);
                    }, disconnected);
                }, disconnected);
            }, disconnected);
        }, disconnected);
    });
}

/*****
 * This function is called at the bottom of this file and is the main entry point
 */
function main() {

    // handle signal interrupt by user
    process.on('SIGINT', exit);

    // configure and start our prompt middleware so we can chat with the user
    prompt.message = ' ';
    prompt.delimiter = ' ';
    prompt.start();

    configure();

    // useful for developer workstation with self signed certs. For other purposes it can be enabled.
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = !params.verifytls || params.verifytls === false ? '0' : '1';

    say('');

    // connect to the API, WWW, authenticate, listen for user input
    // NOTE: this is the main program loop
    portal.connect(_this.VORTEX_WWW_SERVER).then(
        function (settings) {
            _this.VERSION_LATEST = settings.ver;

            //check to see if there is a newer version than the current version
            let compareVer = require('semver-compare');

            //if there is a newer version then inform the user
            if (compareVer(_this.VERSION_LATEST, VERSION) > 0) {
                say(ASK_NEW_VERSION, false);
            }

            api.connect(_this.VORTEX_API_SERVER).then(
                function () {
                    fs.access((params.env ? '-' + params.env : '') + secure, fs.F_OK, (err) => {
                        if (!err) {
                            const hash = fs.readFileSync((params.env ? '-' + params.env : '') + secure, 'utf8');
                            try {
                                aes = JSON.parse(hash);
                                ask(ASK_OLD_PIN, function (pin) {
                                    var raw = aes256.decrypt(aes, pin);
                                    if (raw && raw[0] === '{') {
                                        var token = JSON.parse(raw);
                                        if (token.refresh_token && token.client_id) {
                                            const grant = {
                                                grant_type: 'refresh_token',
                                                client_id: token.client_id,
                                                client_secret: token.refresh_token
                                            };
                                            api.authorize(grant).then(function (token) {
                                                _this.resumed = true;
                                                authenticated(token);
                                            }, function () {
                                                fs.unlink((params.env ? '-' + params.env : '') + secure, (err) => {
                                                });
                                                say('error: '.red + 'invalid logon PIN')
                                                ask(ASK_CREDENTIALS, authenticated);
                                            });
                                        } else {
                                            say('error: '.red + ' Incorrect logon PIN')
                                            ask(ASK_CREDENTIALS, authenticated)
                                        }
                                    } else {
                                        say('error: '.red + 'invalid logon PIN')
                                        fs.unlink((params.env ? '-' + params.env : '') + secure, (err) => {
                                        });
                                    }
                                })
                            } catch (e) {
                                fs.unlink((params.env ? '-' + params.env : '') + secure, (err) => {
                                });
                                ask(ASK_CREDENTIALS, authenticated)
                            }
                        } else ask(ASK_CREDENTIALS, authenticated);
                    })
                },
                exit);
        },
        exit);
}

// accept one item and process it with our replay.js helper
function work(item) {
    var interception = item.interception;
    _this.QUEUE_CURRENT += 1;
    if (_this.QUEUE_CURRENT > _this.QUEUE_MAX) _this.QUEUE_MAX = _this.QUEUE_CURRENT;
    _this.stats[item.interception.interception] = new Date();
    replay.request(interception, params).then(
        function (result) {
            api.reply(result.interception, result.data).then(function () {
                //var end = new Date();
                // var diff = end - _this.stats[item.interception.interception].getTime();
                delete _this.stats[item.interception.interception];
                _this.QUEUE_CURRENT -= 1;
            }, exception);

            if (!_this.COUNT_REPLAYS)
                _this.COUNT_REPLAYS = 1
            else
                _this.COUNT_REPLAYS++;
        },
        function (interception) {
            _this.QUEUE_CURRENT -= 1;
            api.reject(interception).then(nothing, exception);
            if (!_this.COUNT_ERRORS)
                _this.COUNT_ERRORS = 1
            else
                _this.COUNT_ERRORS++;
        }
    )
}

// rest for a moment then poll again
function waitNextPoll(timeout) {
    setTimeout(poll, timeout);
}

// poll vortex for notifications
function poll() {
    if (!_this.paused) {
        api.poll(params).then(
            function (interceptions) {
                if (POLLING_FAULT) say(dateTime() + 'success: '.green + 'Vortex connection restored');
                POLLING_FAULT = false;

                var acks = [];
                interceptions.forEach(function (interception) {
                    acks.push(api.ack(interception));
                })
                if (acks.length > 0) {
                    POLLING_INTERVAL = POLLING_INTERVAL_MIN;  //Reset to check again quickly
                    Promise.all(acks).then(
                        function (items) {
                            items.forEach(function (item) {
                                if (item && item.interception) {
                                    work(item)
                                }
                            });
                            waitNextPoll(0);
                        }, function (failures) {
                            waitNextPoll(0);
                        }
                    );
                } else {
                    //every time there is nothing to do, scale back the polling internal
                    if (POLLING_INTERVAL < POLLING_INTERVAL_MAX) POLLING_INTERVAL += POLLING_INTERVAL_STEP;
                    waitNextPoll(POLLING_INTERVAL);
                }
            },
            function (fault, response) {
                if (!POLLING_FAULT) {
                    say(' ');
                    say(dateTime() + 'error: '.red + 'Vortex connection failed, retrying...');
                }
                POLLING_FAULT = true;
                //increment the polling interval more substantially 
                if (POLLING_INTERVAL < POLLING_INTERVAL_DELAYED_MAX) POLLING_INTERVAL += POLLING_INTERVAL_DELAYED_STEP;
                waitNextPoll(POLLING_INTERVAL);
            }
        );
    } else {
        waitNextPoll(POLLING_INTERVAL_PAUSED);
    }
}

// ask the user a question
function ask(what, callback) {
    switch (what) {
        case ASK_OLD_PIN:
            const old_pin = {
                properties: {
                    pin: {
                        description: 'Enter your 4 digit PIN to sign in:'.cyan,
                        message: 'You must enter 4 numbers'.red,
                        pattern: /^[0-9]{4}$/,
                        replace: '*',
                        hidden: true,
                        required: true
                    }
                }
            };
            prompt.get(old_pin, function (err, result) {
                if (result) {
                    callback(result.pin)
                }
            });
            break;
        case ASK_NEW_PIN:
            const new_pin = {
                properties: {
                    pin: {
                        description: 'Create a 4 digit PIN to save your sign in information:'.cyan,
                        message: 'You must enter 4 numbers'.red,
                        pattern: /^[0-9]{4}$/,
                        replace: '*',
                        hidden: true
                    }
                }
            };
            prompt.get(new_pin, function (err, result) {
                callback(result && result.pin ? result.pin : '');
            });
            break;
        case ASK_CREDENTIALS:
            // If there are command line arguments for username and password
            // then don't bother asking, just try them. If there aren't, prompt.
            let grant;
            let prompt_basic_credential;
            let prompt_mfa_credential;
            prompt_basic_credential = {

                properties: {
                    name: {
                        description: '\n\r' + 'Email address:'.cyan,
                        pattern: /(^[^\s@]+@[^\s@]+\.[^\s@]{2,}$)$/,
                        message: 'Email provided is not valid!'.red,
                        required: true
                    },
                    password: {
                        description: 'Password: '.cyan,
                        replace: '*',
                        hidden: true
                    }
                }
            };
            prompt_mfa_credential = {
                properties: {
                    code: {
                        description: '\n\r' + 'Google Authenticator Code:'.cyan,
                        pattern: /^[0-9]{1,6}$/,
                        message: 'Code is not valid! Enter 6 numbers without a space'.red,
                        required: true
                    }
                }
            };

            if(params.email && params.password) {
                grant = {
                    grant_type: 'password_grant',
                    username: params.email,
                    password: params.password
                };

                api.authorize(grant).then(function (token) {
                    if (token && token.grant_type === 'mfa') {
                        prompt.get(prompt_mfa_credential, function (err, code) {
                            token.client_secret = code.code;
                            api.authorize(token).then(callback, exit);
                        });
                    } else {
                        callback(token);
                    }
                }, exit);

            } else {

                prompt.get(prompt_basic_credential, function (err, result) {
                    if (result) {

                        grant = {
                            grant_type: 'password_grant',
                            username: result.name,
                            password: result.password
                        };

                        api.authorize(grant).then(function (token) {
                            if (token && token.grant_type === 'mfa') {
                                prompt.get(prompt_mfa_credential, function (err, code) {
                                    token.client_secret = code.code;
                                    api.authorize(token).then(callback, exit);
                                });
                            } else {
                                callback(token);
                            }
                        }, exit);
                    }
                });

            }

            break;

        case ASK_FOR_SITE:
            defaultValue = params.site || _this.VORTEX_USER_WEBAPPS[0].host;
            const select_webapp = {
                properties: {
                    webappItem: {
                        description: ('Enter site number (' + (params.site ? 'current: ' : 'default: ') + defaultValue + ')').cyan,
                        message: ('Enter a value between 1 and ' + _this.VORTEX_USER_WEBAPPS.length).red,
                        conform: function (value) {
                            return value > 0 && value < _this.VORTEX_USER_WEBAPPS.length + 1;
                        },
                        required: false
                    }
                }
            };
            for (var s in _this.VORTEX_USER_WEBAPPS) {
                var ss = (parseInt(s) + 1).toString().padEnd(3);
                var txt = ss.cyan + _this.VORTEX_USER_WEBAPPS[s].host;
                say(txt);
            }
            prompt.get(select_webapp, function (err, result) {
                var site = null;
                if (result && parseInt(result.webappItem)) site = _this.VORTEX_USER_WEBAPPS[parseInt(result.webappItem) - 1].host;
                params.site = site;
                callback(params.site);
            });
            break;
        case ASK_FOR_PORT:
            defaultValue = params.port || 8080;
            const askPort = {
                properties: {
                    portItem: {
                        description: ('Enter a port to forward to (' + (params.port ? 'current: ' : 'default: ') + defaultValue + ')').cyan,
                        message: 'Enter a value between 1 and 65535'.red,
                        conform: function (value) {
                            return value > 0 && value < 65536;
                        },
                        required: false
                    }
                }
            };
            prompt.get(askPort, function (err, result) {
                var port = 8080;
                if (result && result.portItem) port = parseInt(result.portItem);
                params.port = port ? port : 8080;
                callback(params.port);
            });
            break;
        case ASK_FOR_HOST:
            defaultValue = params.host || '127.0.0.1';
            const selectHost = {
                properties: {
                    hostItem: {
                        description: ('Enter a host to forward to (' + (params.host ? 'current: ' : 'default: ') + defaultValue + ')').cyan,
                        required: false
                    }
                }
            };
            prompt.get(selectHost, function (err, result) {
                params.host = result && result.hostItem ? result.hostItem : '127.0.0.1';
                callback(params.host);
            });
            break;
        case ASK_FOR_PROVIDER:
            defaultValue = params.provider || 'http';
            const selectProvider = {
                properties: {
                    providerItem: {
                        description: ('Select forwarding host provider (' + (params.provider ? 'current: ' : 'default: ') + defaultValue + ')').cyan,
                        message: 'Must 1 for HTTP or 2 for HTTPS'.red,
                        conform: function (value) {
                            return value === '1' || value === '2';
                        },
                        required: false
                    }
                }
            };
            say('1  '.cyan + 'http');
            say('2  '.cyan + 'https');
            prompt.get(selectProvider, function (err, result) {
                params.provider = (!result || !result.providerItem || result.providerItem === '1') ? 'http' : 'https';
                callback(params.provider);
            });
            break;
    }
}

// Wait for user input and process it
function input(callback) {
    const command = {
        properties: {
            command: {
                description: (_this.paused ? '>'.yellow : '>'.green)
            }
        }
    };
    prompt.get(command, function (err, result) {
        let cmd = result && result.command !== null ? result.command.toLowerCase().trim() : null;

        //build command params
        let cmdParams;
        if (cmd != null) {
            cmdParams = cmd.split(' ');
            cmd = cmdParams[0];
        }

        //handle command
        switch (cmd) {
            // CTRL-C causes this
            case null:
                say('Session ended', true);
                return;
            case '':
                say('counters')
                break;
            case 'pause':
                if (_this.paused) {
                    say('Forwarding is already paused.')
                } else {
                    say('Forwarding is paused. Type ' + 'resume'.cyan + ' to continue.')
                }
                _this.paused = true;
                break;
            case 'resume':
                if (!_this.paused) {
                    say('Forwarding already resumed.')
                } else {
                    say('Forwarding resumed.')
                }
                _this.paused = false;
                break;
            case 'quit':
            case 'q':
            case 'exit':
            case 'x':
                say('')
                say('Thank you for using Vortex 👍');
                say('')
                process.exit(0);
                break;
            case 'sites':
                api.webapps(
                    function (webapps) {
                        say('Your sites:')
                        if (!webapps || webapps.length === 0) {
                            say('No sites found'.red);
                        } else {
                            _this.VORTEX_USER_WEBAPPS = webapps;
                            showUserSites(_this.VORTEX_USER_WEBAPPS, false, params.site);
                        }
                        say('');
                        input(callback);
                    }, function (ex) {
                        input(callback)
                    }
                );
                return;

            //handle set commands
            case 'set':
                if (cmdParams.length === 1) {
                    say('missing additional parameters (e.g. site, host, port, provider)')
                } else {
                    switch (cmdParams[1].toLowerCase()) {
                        case 'site':
                            askIfMissing(ASK_FOR_SITE, params.site).then((site) => {
                                params.site = site;
                                say('status');
                                input(callback)
                            });
                            break;
                        case 'port':
                            askIfMissing(ASK_FOR_PORT, params.port).then((port) => {
                                params.port = port;
                                say('status');
                                input(callback)
                            });
                            break;

                        case 'host':
                            askIfMissing(ASK_FOR_HOST, params.host).then((host) => {
                                params.host = host;
                                say('status');
                                input(callback)
                            });
                            break;

                        case 'provider':
                            askIfMissing(ASK_FOR_PROVIDER, params.provider).then((provider) => {
                                params.provider = provider;
                                say('status');
                                input(callback)
                            });
                            break;

                        case 'verifytls':
                            if (cmdParams.length !== 3) {
                                say(('Expecting 2 values, received ' + cmdParams.length).red);
                                say('Try: ' + 'set verifytls <on | off>'.cyan);
                                break;
                            }
                            let cmdTLSReject = cmdParams[2].toLowerCase() === 'on';
                            params.verifytls = cmdTLSReject;
                            say('TLS verification set to: ' + (cmdTLSReject ? 'on' : 'off').dim);
                            process.env.NODE_TLS_REJECT_UNAUTHORIZED = !params.verifytls || params.verifytls === false ? '0' : '1';
                            input(callback);
                            break;

                        default:
                            say("Not a valid 'set' command. Use ".red + 'help'.cyan + ' for commands.'.red);
                            input(callback);
                    }
                    return;
                }
                break;

            // show the help screen
            case 'help':
            case '?':
                say('Available commands for Vortex Shell');
                say('');
                say(' quit'.cyan + '                     Exit the vortex client shell');
                say('     '.cyan + '                       aliases: ' + 'q, x, exit'.cyan);
                say('');
                say(' help'.cyan + '                     Display this help information');
                say('              '.cyan + '              alias: ' + '?'.cyan);
                say('');
                say(' pause'.cyan + '                    Stop forwarding');
                say(' resume'.cyan + '                   Resume forwarding');

                say('');
                say(' sites'.cyan + '                    Refresh sites for your account');
                say(' set site'.cyan + '                 Select site for this session');
                say('');
                say(' set host '.cyan + '<host>'.blue + '          Forward to host');
                say(' set port '.cyan + '<port>'.blue + '          Forward to port');
                say(' set provider '.cyan + '<provider>'.blue + '  Forward as HTTP or HTTPS');
                say(' set verifytls '.cyan + '<on | off>'.blue + " TLS Verification");
                say('                          Turn off to support self-signed SSL certificates'.grey);

                say('');
                say(' status'.cyan + '                   Current session details')
                say(' counters'.cyan + '                 Show forwarding counters')
                say(' reset'.cyan + '                    Reset forwarding counters')
                say('');
                break;

            case 'status':
                say('status');
                break;
            case 'counters':
                say('counters');
                break;
            case 'reset':
                _this.COUNT_ERRORS = 0;
                _this.COUNT_REPLAYS = 0;
                _this.QUEUE_CURRENT = 0;
                _this.QUEUE_MAX = 0;
                say('Forward stats cleared'.dim);
                break;

            default:
                if (cmd) say('Invalid command. Type ' + 'help'.green + ' for more information.')
        }

        input(callback);

    });
}

function showUserSites(webapps, showIndex, matchSite) {
    var counter = 1;
    let matchedSite = false;
    if (webapps) {
        webapps.forEach((item) => {
            let itemHost = item.host.toLowerCase();

            if ((itemHost === (!matchSite ? params.site : matchSite.toLowerCase()))) {
                matchedSite = true;
                say((showIndex ? counter++ + ') ' : '') + (matchedSite ? itemHost.green : itemHost));
            } else {
                say((showIndex ? counter++ + ') ' : '') + (matchedSite ? itemHost : itemHost));
            }
        })

        if (!matchedSite) say('Your current site no longer exists!'.red);
    } else {
        say('Error: There are no sites available for your account.'.red);
    }
}

// start our engine
main();
