/* Module dependencies  */
var unirest = require('unirest');

module.exports = {
    /**
     * Connect to a Vortex Client API URL
     */
    connect: function (url) {
        var _this = this;
        _this.api = url;

        return new Promise(function (success, failure) {
            // Make request to Vortex to check validity
            try {
                unirest.get(url + '/download/version')
                    .type('json')
                    .end(function (res) {
                        if (res.status === 200) {
                            success(res.body);
                        } else {
                            failure('error:   Connection failed'.red);
                        }
                    });
            } catch (ex) {
                failure('error:   Connection failed'.red);
            }
        });
    }
};
