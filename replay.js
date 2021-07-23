/* Module dependencies  */
var https = require('https'),
    http = require('http'),
    url = require('url'),
    colors = require('colors'),         // https://www.npmjs.com/package/colors
    querystring = require('querystring');

function error(str) {
    if (this._error) this._error(str);
    else console.log(str);
}
function log(str) {
    if (this._log) this._log(str);
    else console.log(str);
}

// assemble the data from the node express request object
function assemble(interception, success, failure, res) {
    try {
        if (res) {
            var data = '';
            res.setEncoding('binary');
            res.on('data', function (chunk) {
                data += chunk;
            });
            res.on('end', function () {
                interception.output.status = res.statusCode;
                for (var h in res.headers) {
                    interception.output.headers[h] = res.headers[h];
                }
                success({interception: interception, data: data});
            });
        } else {
            interception.output.code = 8000;
            interception.output.msg = 'Assembly Error';
            failure(interception);
        }
    } catch (ex) {
        error('error: failed to assemble network stream')
        error(ex);
        interception.output.code = 500;
        interception.output.msg = 'Unknown Error';
        failure(interception);
    }
}

// perform the request replay
function request(interception, params) {

    return new Promise(function (success, failure) {
        try {
            const thisUrl = url.parse(interception.input.url);
            const provider = (params.provider === 'http') ? http : https;
            const host = params.host;
            const port = params.port;
            const path = decodeURIComponent(thisUrl.path);
            const interceptionVerb = interception.input.method.toLowerCase();

            //build journal output
            interception.output = {
                status: -1,
                headers: {},
                host: params.host,
                port: params.port,
                provider: params.provider,
                factory: 'debugger',
                msg: '',
                code: -1
            }

            // build request options
            let replayOpts = {
                host: host,
                port: port,
                path: path,
                method: interceptionVerb.toUpperCase(),
                headers: interception.input.headers
            };

            // make sure that the interception verb is one we support
            switch (interceptionVerb) {
                case 'get':
                case 'post':
                case 'delete':
                case 'patch':
                case 'put':
                    let input = interception.input.body || '';

                    // parse the request path to build the replayOpts object used for replay
                    let splitAt = replayOpts.path.indexOf('?');
                    if (splitAt >= 0) {
                        let qs = replayOpts.path.substring(splitAt + 1).split(' ').join('+');
                        replayOpts.path = replayOpts.path.substring(0, splitAt).split(' ').join('%20') + '?' + qs;
                    } else {
                        replayOpts.path = replayOpts.path.split(' ').join('%20');
                    }

                    log(interceptionVerb.green + ' ' + params.provider + '://' + host + ':' + port + replayOpts.path);

                    // perform the replay request
                    let replayRequest = provider.request(replayOpts, function (res) {
                        assemble(interception, success, failure, res);
                    });

                    // if there is data input (e.g. body data) then send it only if it isn't a get verb
                    if ( interceptionVerb !== 'get' && typeof input !== 'object') replayRequest.write(input);

                    // end the request
                    replayRequest.end();

                    // request on handler for an error
                    replayRequest.on('error', function (e) {
                        error('error: '.red + interceptionVerb + ' ' + params.provider + '://' + host + ':' + port + replayOpts.path);
                        switch (e.code) {
                            case 'ECONNREFUSED':
                                interception.output.code = 9100;
                                interception.output.msg = 'Connection Refused';
                                failure(interception);
                                break;
                            default:
                                interception.output.code = 9199;
                                interception.output.msg = e.code;
                                failure(interception);
                                break;
                        }
                    });
                    break;

                // default behavior is to not support the unknown verb type
                default:
                    log('not supported: '.red + interceptionVerb + ' ' + params.provider + '://' + host + ':' + port + replayOpts.path);
                    interception.output.code = 9000;
                    interception.output.msg = 'Method Not Allowed';
                    failure(interception);
                    break;
            }
        } catch (ex) {
            error('error: ' + 'unexpected error during replay request');
            error(ex)
            interception.output.code = 9999;
            interception.output.msg = 'Unhandled Exception';
            failure(interception);
        }
    });
}

module.exports = {
    /**
     * Request a different host perform the job
     */
    request: request,
    onError: function(fn) {
        if (fn) this._error = fn;
    },
    onLog: function(fn) {
        if (fn) this._log = fn;
    }
};
