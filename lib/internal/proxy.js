var http = require('http');
var xml2js = require('xml2js');

var executeBBBCall = exports.executeBBBCall = function (url, callback) {

    var parser = new xml2js.Parser();

    http.request(url, function(res) {
        res.setEncoding('utf8');
        res.on('data', function (chunk) {
            parser.parseString(chunk, function(err, result) {
            	if(err) {
            		return callback(err);
            	}

            	console.info(result);
                if(result['response']['returncode'] == "SUCCESS") {
                	return callback(null, result['response']);
				} else {
                	return callback(null, result['response']);
				}				
			});
		});
	}).end();
};