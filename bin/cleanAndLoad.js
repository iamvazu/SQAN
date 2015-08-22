#!/usr/bin/node

//os
var fs = require('fs');

//contrib
var amqp = require('amqp');

//mine
var config = require('../config/config');
var models = require('../models');
var instance = require('../qc/instance');

//to-be-initizalied
var conn = null;
var cleaned_ex = null;
var cleaned_q = null;
var failed_q = null;
var incoming_q = null;

models.init(function(err) {
    if(err) throw err;

    conn = amqp.createConnection(config.amqp);
    conn.on('ready', function () {
        console.log("connected to amqp");
        conn.exchange(config.cleaner.ex, {confirm: true, autoDelete: false, durable: true, type: 'topic'}, function(_cleaned_ex) {
            cleaned_ex = _cleaned_ex;
            conn.queue(config.cleaner.failed_q, {autoDelete: false, durable: true}, function(_failed_q) {
                failed_q = _failed_q;
                conn.queue(config.cleaner.q, {autoDelete: false, durable: true}, function(_cleaned_q) {
                    cleaned_q = _cleaned_q;
                    cleaned_q.bind(config.cleaner.ex, '#', function() {
                        conn.queue(config.incoming.q, {autoDelete: false, durable: true}, function (_incoming_q) {
                            incoming_q = _incoming_q;
                            incoming_q.subscribe({ack: true, prefetchCount: 1}, handle_message);
                        });
                    });
                });
            });
        });
    });
});

//here is the main business logic
function handle_message(h, msg_h, info, ack) {
    //pull IIBIS-ID (we need this so that we can organize .json into directory named with iibisid
    var iibisid = parseIIBISID(h);
    h.qc_iibisid = iibisid;

    //first of all, store a copy of raw input
    var path = config.cleaner.raw_headers+"/"+iibisid;
    write_to_disk(path, h, function(err) {
        if(err) throw err;
        //then start the cleanup.
        try {
            //var _source = JSON.stringify(h);
            var index = composeESIndex(h);
            console.log(iibisid+" esindex:"+index+" "+h.SOPInstanceUID);
            h.qc_esindex = index;

            instance.clean(h);

            //ok let's publish to amqp (for es)
            cleaned_ex.publish('', h, {}, function(err) {
                if(err) throw err;
                
                //also write cleaned data to file (shouldn't be needed, but just in case)
                var cleanpath = config.cleaner.cleaned_headers+"/"+h.qc_iibisid;
                write_to_disk(cleanpath, h, function(err) {
                    if(err) throw err;
                    write_to_mongo(h, function(err) {
                        if(err) throw err;
                        //all good
                        ack.acknowledge();
                    });
                });
            });
        } catch(ex) {           
            console.log("caught exception while cleaning");
            console.dir(h); 
            console.log(ex, ex.stack);
            conn.publish(config.cleaner.failed_q, h); //publishing to default exchange can't be confirmed?
            //also write to file
            fs.writeFile(config.cleaner.failed_headers+"/"+h.SOPInstanceUID+".json", JSON.stringify(h,null,4), function(err) {
                if(err) throw err;
                ack.acknowledge();
            }); 
        }
    });
}

function write_to_disk(dir, h, cb) {
    fs.exists(dir, function (exists) {
        if(!exists) fs.mkdirSync(dir);
        fs.writeFile(dir+"/"+h.SOPInstanceUID+".json", JSON.stringify(h,null,4), cb);
    });
}

function write_to_mongo(h, cb) {
    var keys = {
        IIBISID: h.qc_iibisid,
        Modality: h.Modality,
        RadioTracer: "TODO" //TODO how do I get this?
    };
    models.Study.findOne(keys, function(err, study) {
        if(err) return cb(err);
        if(study) {
            //known study
            if(study.PatientIDs.indexOf(h.PatientID) === -1) {
                study.PatientIDs.push(h.PatientID);
            }
            if(study.SeriesInstanceUID.indexOf(h.SeriesInstanceUID) === -1) {
                study.SeriesInstanceUID.push(h.SeriesInstanceUID);
            }
        } else {
            //create a new study
            keys.PatientIDs = [h.PatientID];
            keys.SeriesInstanceUIDs = [h.SeriesInstanceUID];
            study = new models.Study(keys);
        }
        study.save(cb);
    });
}

function parseIIBISID(h) {
    //(from Sundar)
    //1. I mentioned that IIBIS-ID as LastName in PatientName. You will need to parse PatientName filed with "^" as separator and take the first element as LastName. 
    //2. I do not think fMRIQA scans are ever scanned with IIBIS-ID convention (as LastName in PatientName), so that could explain graphs.
    if(h.PatientName) {
        var ts = h.PatientName.split("^");
        return ts[0];
    } else {
        return null;
    }
}

function composeESIndex(h) {
    var id = "";

    //concat various index fields (defined by Sundar / Dr. Hutchins)
    var index_fields = [h.Modality, h.ManufacturerModelName, h.StationName, h.SoftwareVersions];
    index_fields.forEach(function(field) {
        if(!field) throw new Error("missing esindex fields");
        if(id != "") id += ".";
        field = field.replace(/\W+/g,'_'); //replace all-non-alphanumeric chars to _
        field = field.toLowerCase();
        id += field;
    });

    return id;
}


