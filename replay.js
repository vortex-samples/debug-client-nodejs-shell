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
function request(interception, params) {
    return new Promise(function (success, failure) {
        try {
            const thisUrl = url.parse(interception.input.url);
            const provider = (params.provider === 'http') ? http : https;
            const host = params.host;
            const port = params.port;
            const path = decodeURIComponent(thisUrl.path);
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
            switch (interception.input.method.toLowerCase()) {
                case 'get':
                    var opts = {
                        host: host,
                        port: port,
                        path: path,
                        method: 'GET',
                        headers: interception.input.headers
                    };
                    log('get: '.green + params.provider + '://' + host + ':' + port + opts.path);
                    var splitAt = opts.path.indexOf('?');
                    if (splitAt >= 0) {
                        var qs = opts.path.substring(splitAt + 1).split(' ').join('+');
                        opts.path = opts.path.substring(0, splitAt).split(' ').join('%20') + '?' + qs;
                    } else {
                        opts.path = opts.path.split(' ').join('%20');
                    }
                    var reqGet = provider.request(opts, function (res) {
                        assemble(interception, success, failure, res);
                    });
                    reqGet.end();
                    reqGet.on('error', function (e) {
                        log('error: '.red + params.provider + '://' + host + ':' + port + opts.path);
                        switch (e.code) {
                            case 'ECONNREFUSED':
                                interception.output.code = 9100;
                                interception.output.msg = 'Connection Refused'
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
                case 'post':
                    var input = interception.input.body || '';
                    var opts = {
                        host: host,
                        port: port,
                        path: path,
                        method: 'POST',
                        headers: interception.input.headers
                    };
                    var splitAt = opts.path.indexOf('?');
                    if (splitAt >= 0) {
                        var qs = opts.path.substring(splitAt + 1).split(' ').join('+');
                        opts.path = opts.path.substring(0, splitAt).split(' ').join('%20') + '?' + qs;
                    } else {
                        opts.path = opts.path.split(' ').join('%20');
                    }
                    log('post: '.green + params.provider + '://' + host + ':' + port + opts.path);
                    var reqPost = provider.request(opts, function (res) {
                        assemble(interception, success, failure, res);
                    });
                    if (typeof input !== 'object') reqPost.write(input);
                    reqPost.end();
                    reqPost.on('error', function (e) {
                        error('error: '.red + params.provider + '://' + host + ':' + port + opts.path);
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
                case 'delete':
                    var opts = {
                        host: host,
                        port: port,
                        path: path,
                        method: 'DELETE',
                        headers: interception.input.headers
                    };
                    var splitAt = opts.path.indexOf('?');
                    if (splitAt >= 0) {
                        var qs = opts.path.substring(splitAt + 1).split(' ').join('+');
                        opts.path = opts.path.substring(0, splitAt).split(' ').join('%20') + '?' + qs;
                    } else {
                        opts.path = opts.path.split(' ').join('%20');
                    }
                    log('delete: '.green + params.provider + '://' + host + ':' + port + opts.path);
                    var reqDelete = provider.request(opts, function (res) {
                        assemble(interception, success, failure, res);
                    });
                    reqDelete.end();
                    reqDelete.on('error', function (e) {
                        error('error: '.red + params.provider + '://' + host + ':' + port + opts.path);
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
                default:
                    log('not supported: '.red + interception.input.method.toLowerCase() + ' ' + params.provider + '://' + host + ':' + port + opts.path);
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
