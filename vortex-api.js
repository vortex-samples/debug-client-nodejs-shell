/* Module dependencies  */
var unirest = require('unirest'),
    request = require('request');

// safe-get a field from body of a node express response object
function getResField(res, field) {
    if (res && res.statusCode && res.statusCode === 200 && res.body) {
        if (field) {
            if (field.indexOf('.') > 0) {
                var path = field.split('.');
                var curr = res.body;
                for (var p in path) {
                    if (path[p] && curr[path[p]]) {
                        curr = curr[path[p]];
                    } else return null;
                }
                return curr;
            } else return (res.body[field]);
        } else return res.body;
    } else return null;
}

// wait for a 202 response to complete for ttl seconds, using a timer
function await202(url, count, ttl, success, failure) {
    if (count >= ttl) {
        failure(408, 'Error - Timeout');
    } else {
        unirest.get(url)
            .type('json')
            .end(function (result) {
                if (result.status === 202) {
                    setTimeout(function () {
                        await202(url, count + 1, ttl, success, failure);
                    }, 250);
                } else {
                    success(result);
                }
            });
    }
}

// helper function used to post data and follow 202 responses on a timer.
function post(url, access_token, data, success, failure) {
    unirest.post(url)
        .type('json')
        .header('Authorization', 'Bearer ' + access_token.access_token)
        .send(data)
        .end(function (r) {
            if (r.statusCode === 202) {
                var loc = url.substring(0, url.indexOf('/v1')) + r.body.location;
                await202(loc, 0, 5, success, failure);
            } else success(r);
        });
}

// helper function used to post data and follow 202 responses on a timer.
function get(url, access_token, data, success, failure) {
    unirest.get(url)
        .type('json')
        .header('Authorization', 'Bearer ' + access_token.access_token)
        .end(function (r) {
            if (r.statusCode === 202) {
                var loc = url.substring(0, url.indexOf('/v1')) + r.body.location;
                await202(loc, 0, 5, success, failure);
            } else success(r);
        });
}

module.exports = {
    /**
     * Connect to a Vortex Client API URL
     */
    connect: function (url) {
        var _this = this;
        _this.api = url;

        return new Promise(function (success, failure) {
            // Make request to Vortex to check validity
            unirest.get(url)
                .type('json')
                .end(function (res) {
                    if (getResField(res, 'status') === 'ok') {
                        success();
                    } else {
                        failure('error:   Connection failed'.red);
                    }
                });
        });
    },

    /**
     * Convert a basic grant into an access token
     */
    authorize: function (grant) {
        let _this = this;
        return new Promise(function (success, failure) {
            unirest.post(_this.api + '/oauth/token')
                .type('json')
                .header('Accept', 'application/json')
                .json(grant)
                .end(function (res) {
                    var reply = res && res.body && res.body.data ? res.body.data : {};
                    if (reply.grant_type === 'bearer') _this.token = reply;
                    var errorMsg = '';
                    if (grant.grant_type === 'password_grant' && !(reply.grant_type === 'mfa' || reply.grant_type === 'bearer')) errorMsg = 'error:  '.red + 'Invalid username or password'
                    if (grant.grant_type === 'mfa' && reply.grant_type !== 'bearer') errorMsg = 'error:  '.red + 'Invalid multi-factor authorization code. You can remove MFA at on sign in screen of the Vortex Hub website.'
                    if (grant.grant_type === 'refresh_token' && reply.grant_type !== 'bearer') errorMsg = 'error:  '.red + 'Your session has expired'
                    if (reply && reply.object && reply.object.error) errorMsg = 'error:  '.red + reply.object.error;
                    errorMsg ? failure(errorMsg) : success(reply);
                });
        })
    },

    /**
     * Get list of web apps
     */
    webapps: function () {
        let _this = this;
        return new Promise(function (success, failure) {
            get(_this.api + '/webapps',
                _this.token,
                {},
                function (res) {
                    if (res.status === 200) {
                        var result = getResField(res, 'data.webapps');
                        if (result && result.length > 0) success(result);
                        else failure('error: failed to retrieve sites');
                    } else failure('error: failed to connect');

                },
                function (reason) {
                    failure('error:   failed to get your sites');
                }
            );
        })
    },

    /**
     * Get details about a webapp for validation
     */
    webapp: function (nameOrIdentity) {
        let _this = this;
        return new Promise(function (success, failure) {
            get(_this.api + '/webapp/' + nameOrIdentity,
                _this.token,
                {},
                function (res) {
                    if (res.status === 200) {
                        var result = getResField(res, 'data.webapp');
                        if (result) success(result);
                        else failure('error:   failed to connect ' + nameOrIdentity);
                    } else {
                        failure('error:   failed to connect ' + nameOrIdentity);
                    }
                },
                function (reason) {
                    failure('error:   failed to get ' + nameOrIdentity);
                });
        })
    },

    /**
     * Get details about a breakpoint for validation
     */
    breakpoint: function (nameOrIdentity) {
        let _this = this;
        return new Promise(function (success, failure) {
            get(_this.api + '/breakpoint/' + nameOrIdentity,
                _this.token,
                {},
                function (res) {
                    if (res.status === 200) {
                        var result = getResField(res, 'data.breakpoint');
                        if (result) success(result);
                        else failure('error:   failed to get ' + nameOrIdentity);
                    } else {
                        failure('error:   failed to get ' + nameOrIdentity);
                    }
                },
                function (reason) {
                    failure('error:   failed to get ' + nameOrIdentity);
                });
        })
    },

    /**
     * Poll the api for notifications about new reply items (a.k.a. interceptions)
     */
    poll: function (params) {
        let _this = this;
        return new Promise(function (success, failure) {
            var options = {
                method: 'post',
                url: _this.api + '/poll',
                headers: {"Authorization": "Bearer " + _this.token.access_token},
                json: {
                    interception: {
                        status: 'new',
                        webapp: params.site
                    }
                }
            };
            request(options, function (error, response, body) {
                if (error || !body || !body.data) failure(error);
                else {
                    success(body.data.interceptions || []);
                }
            });

        })
    },

    /**
     * Reply to an interception with data
     */
    reply: function (interception, buffer) {
        if (buffer && buffer.length) {
            interception.output.size = buffer.length;
            if (buffer.length > 40) {
                interception.output.preview = buffer.substr(0, 20) + '......' + buffer.substr(buffer.length - 20);
            } else {
                interception.output.preview = buffer;
            }
        }
        let _this = this;
        return new Promise(function (success, failure) {
            var metadata = {
                filename: interception.interception + '.bin'
            };
            var url = _this.api + '/interception/' + interception.interception + '/body';
            var boundary = interception.interception;
            var data = "";
            for (var i in metadata) {
                if ({}.hasOwnProperty.call(metadata, i)) {
                    data += "--" + boundary + "\r\n";
                    data += "Content-Disposition: form-data; name=\"" + i + "\"; \r\n\r\n" + metadata[i] + "\r\n";
                }
            }
            data += "--" + boundary + "\r\n";
            data += "Content-Disposition: form-data; name=\"file\"; filename=\"" + metadata.filename + "\"\r\n";
            data += "Content-Type:application/octet-stream\r\n\r\n";
            var payload2 = Buffer.concat([
                Buffer.from(data, "utf8"),
                Buffer.from(buffer, 'binary'),
                Buffer.from("\r\n--" + boundary + "--\r\n", "utf8"),
            ]);
            var options = {
                method: 'post',
                url: url,
                headers: {"Content-Type": "multipart/form-data; boundary=" + boundary},
                body: payload2,
            };
            request(options, function (error, response, body) {
                var options = {
                    method: 'post',
                    url: _this.api + '/interception/' + interception.interception,
                    headers: {"Authorization": "Bearer " + _this.token.access_token},
                    json: {result: 'replied', status: 'reply', output: interception.output}
                };
                request(options, function (error, response, body) {
                    if (error) failure(error);
                    else {
                        success(body.data);
                    }
                });
            });
        })
    },
    /**
     * Reject an interception
     */
    reject: function (interception) {
        let _this = this;
        return new Promise(function (success, failure) {
            var options = {
                method: 'post',
                url: _this.api + '/interception/' + interception.interception,
                headers: {"Authorization": "Bearer " + _this.token.access_token},
                json: {result: 'rejected', status: 'reject', output: interception.output}
            };
            request(options, function (error, response, body) {
                if (error) failure(error);
                else {
                    success(body.data);
                }
            });
        })
    },
    /**
     * Acknowledge interception data
     */
    ack: function (interception) {
        let _this = this;
        return new Promise(function (success, failure) {
            var options = {
                method: 'post',
                url: _this.api + '/interception/' + interception.interception,
                headers: {"Authorization": "Bearer " + _this.token.access_token},
                json: {status: 'accept', output: interception.output}
            };
            request(options, function (error, response, body) {
                if (error) failure(error, response);
                else {
                    success(body.data);
                }
            });
        });
    }
};
