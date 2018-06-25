'use strict';

//contrib
var express = require('express');
var router = express.Router();
var winston = require('winston');
var jwt = require('express-jwt');
var async = require('async');

//mine
var config = require('../../config');
var logger = new winston.Logger(config.logger.winston);
var db = require('../models');
var qc = require('../qc');

//get all researches that user can view
router.get('/', jwt({secret: config.express.jwt.pub}), function(req, res, next) {
    var query = db.Research.find();
    query.sort('-IIBISID');
    query.exec(function(err, rs) {
        if(err) return next(err);
        //if admin parameter is set and if user is admin, return all (used to list all iibisid on admin page)
        if(req.query.admin && ~req.user.scopes.dicom.indexOf('admin')) {
            return res.json(rs);
        }
        db.Acl.getCan(req.user, 'view', function(err, iibisids) {
            //only show iibisids that user has access to
            var researches = [];
            rs.forEach(function(r) {
                if(~iibisids.indexOf(r.IIBISID)) researches.push(r);
            });
            res.json(researches);
        }); 
    });
});

router.get('/summary/:id', function(req, res, next) {
    var subjects = {};
    db.Series.find({'research_id': req.params.id}, {'series_desc' : 1, 'subject' : 1, 'qc' : 1, 'qc1_state' : 1}).exec(function(err, _series){
        if(err) return next(err);
        db.Series.distinct('subject', {'research_id': req.params.id}).exec(function(err, _subjects){
            if(err) return next(err);
            db.Series.distinct('series_desc', {'research_id': req.params.id}).exec(function(err, _seriesDesc){
                if(err) return next(err);
                _subjects.forEach(function(sub){
                    subjects[sub] = {}
                    _series.forEach(function(ser){
                        if(ser.subject == sub){
                            subjects[sub][ser.series_desc] = ser;
                        }
                    });
                });

                res.json({series_desc: _seriesDesc, subjects: subjects});
            });
        });
    });
});

//rerun QC1 on the entire "research"
router.post('/reqc', jwt({secret: config.express.jwt.pub}), function(req, res, next) {
    db.Research.find(req.body).exec(function(err, researches) {
        if(err) return next(err);
        var total_modified = 0;
        var event = {
            user_id: req.user.sub,
            title: "Research-level ReQC",
            date: new Date(), //should be set by default, but UI needs this right away
            detail: "",
        };
        async.forEach(researches, function(research, done) {
            //make sure user has access to this research
            db.Acl.can(req.user, 'qc', research.IIBISID, function(can) {
                if(!can) return res.status(401).json({message: "you are not authorized to QC this IIBISID:"+research.IIBISID});
                //invalidate series QC (although not exactly necessary..)
                db.Series.update({research_id: research._id}, {$unset: {qc: 1}, $push: {'events': event}}, {multi: true}, function(err, affected) {
                    if(err) return next(err);
                    //invalidate image QC.
                    db.Image.update({research_id: research._id}, {$unset: {qc: 1}}, {multi: true}, function(err, affected){
                        if(err) return next(err);
                        total_modified += affected.nModified;
                        done();
                    });
                });
            });
        }, function(err) {
            res.json({message: "Re-running QC on "+total_modified+" images."});
        });
    });
});


module.exports = router;

