/*!
 * Copyright 2014 Apereo Foundation (AF) Licensed under the
 * Educational Community License, Version 2.0 (the "License"); you may
 * not use this file except in compliance with the License. You may
 * obtain a copy of the License at
 *
 *     http://opensource.org/licenses/ECL-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an "AS IS"
 * BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express
 * or implied. See the License for the specific language governing
 * permissions and limitations under the License.
 */

var _ = require('underscore');
var util = require('util');

var AuthzUtil = require('oae-authz/lib/util');
var log = require('oae-logger').logger('meetings-search');
var MessageBoxSearch = require('oae-messagebox/lib/search');
var SearchAPI = require('oae-search');
var SearchConstants = require('oae-search/lib/constants').SearchConstants;
var TaskQueue = require('oae-util/lib/taskqueue');
var TenantsAPI = require('oae-tenants');

var MeetingsAPI = require('./api');
var MeetingsConstants = require('./constants').MeetingsConstants;
var MeetingsDAO = require('./internal/dao');


/**
 * Initializes the child search documents for the Meetings module
 *
 * @param  {Function}   callback        Standard callback function
 * @param  {Object}     callback.err    An error that occurred, if any
 */
var init = module.exports.init = function(callback) {
    return MessageBoxSearch.registerMessageSearchDocument(MeetingsConstants.search.MAPPING_MEETING_MESSAGE, ['meeting'], function(resources, callback) {
        return _produceMeetingMessageDocuments(resources.slice(), callback);
    }, callback);
};


////////////////////
// INDEXING TASKS //
////////////////////

/*!
 * When a meeting is created, we must index it and all its potential members
 */
MeetingsAPI.on(MeetingsConstants.events.CREATED_MEETING, function(ctx, meeting, members) {
    SearchAPI.postIndexTask('meeting', [{'id': meeting.id}], {
        'resource': true,
        'children': {
            'resource_members': true
        }
    });
});

/*!
 * When a meeting is updated, we must reindex its resource document
 */
MeetingsAPI.on(MeetingsConstants.events.UPDATED_MEETING, function(ctx, meeting, updatedMeeting) {
    SearchAPI.postIndexTask('meeting', [{'id': meeting.id}], {
        'resource': true
    });
});

/*!
 * When a meeting's membership is updated, we must reindex its members child document
 */
MeetingsAPI.on(MeetingsConstants.events.UPDATED_MEETING_MEMBERS, function(ctx, meeting) {
    SearchAPI.postIndexTask('meeting', [{'id': meeting.id}], {
        'children': {
            'resource_members': true
        }
    });
});

/*!
 * When a meeting is deleted, we must cascade delete its resource document and children
 */
MeetingsAPI.on(MeetingsConstants.events.DELETED_MEETING, function(ctx, meeting) {
    SearchAPI.postDeleteTask(meeting.id);
});

/*!
 * When a message is added to a meeting, we must index the child message document
 */
MeetingsAPI.on(MeetingsConstants.events.CREATED_MEETING_MESSAGE, function(ctx, message, meeting) {
    var resource = {
        'id': meeting.id,
        'messages': [message]
    };

    SearchAPI.postIndexTask('meeting', [resource], {
        'children': {
            'meeting_message': true
        }
    });
});

/*!
 * When a meeting message is deleted, we must delete the child message document
 */
MeetingsAPI.on(MeetingsConstants.events.DELETED_MEETING_MESSAGE, function(ctx, message, meeting, deleteType) {
    return MessageBoxSearch.deleteMessageSearchDocument(MeetingsConstants.search.MAPPING_MEETING_MESSAGE, meeting.id, message);
});



////////////////////////
// DOCUMENT PRODUCERS //
////////////////////////

/**
 * Produce the necessary meeting message search documents.
 *
 * @see MessageBoxSearch.registerMessageSearchDocument
 * @api private
 */
var _produceMeetingMessageDocuments = function(resources, callback, _documents, _errs) {
    _documents = _documents || [];
    if (_.isEmpty(resources)) {
        return callback(_errs, _documents);
    }

    var resource = resources.pop();
    if (resource.messages) {
        var documents = MessageBoxSearch.createMessageSearchDocuments(MeetingsConstants.search.MAPPING_MEETING_MESSAGE, resource.id, resource.messages);
        _documents = _.union(_documents, documents);
        return _produceMeetingMessageDocuments(resources, callback, _documents, _errs);
    }

    // If there were no messages stored on the resource object, we go ahead and index all messages for the meeting
    MessageBoxSearch.createAllMessageSearchDocuments(MeetingsConstants.search.MAPPING_MEETING_MESSAGE, resource.id, resource.id, function(err, documents) {
        if (err) {
            _errs = _.union(_errs, [err]);
        }

        _documents = _.union(_documents, documents);
        return _produceMeetingMessageDocuments(resources, callback, _documents, _errs);
    });
};

/**
 * Produces search documents for 'meeting' resources.
 *
 * @see SearchAPI#registerSearchDocumentProducer
 * @api private
 */
var _produceMeetingSearchDocuments = function(resources, callback) {
    _getMeetings(resources, function(err, meetings) {
        if (err) {
            return callback([err]);
        }

        // Some meetings might have already been deleted
        meetings = _.compact(meetings);
        if (_.isEmpty(meetings)) {
            return callback();
        }

        var docs = _.map(meetings, _produceMeetingSearchDocument);
        return callback(null, docs);
    });
};

/**
 * Gets a set of meetings.
 *
 * @param  {Object[]}   resources   An array of resources to index.
 * @param  {Function}   callback    Standard callback function
 * @api private
 */
var _getMeetings = function(resources, callback) {
    var meetings = [];
    var meetingIds = [];

    _.each(resources, function(resource) {
        if (resource.meeting) {
            dicussions.push(resource.meeting);
        } else {
            meetingIds.push(resource.id);
        }
    });

    if (_.isEmpty(meetingIds)) {
        return callback(null, meetings);
    }

    MeetingsDAO.getMeetingsById(meetingIds, null, callback);
};

/**
 * Given a meeting item, it produces an appropriate search document.
 *
 * @param  {Meeting}     meeting  The meeting item to index.
 * @return {SearchDoc}                  The produced search document.
 * @api private
 */
var _produceMeetingSearchDocument = function(meeting) {
    // Allow full-text search on name and description, but only if they are specified. We also sort on this text
    var fullText = _.compact([meeting.displayName, meeting.description]).join(' ');

    // Add all properties for the resource document metadata
    var doc = {
        'resourceType': 'meeting',
        'id': meeting.id,
        'tenantAlias': meeting.tenant.alias,
        'displayName': meeting.displayName,
        'visibility': meeting.visibility,
        'q_high': meeting.displayName,
        'q_low': fullText,
        'sort': meeting.displayName,
        '_extra': {
            'lastModified': meeting.lastModified
        }
    };

    if (meeting.description) {
        doc.description = meeting.description;
    }

    return doc;
};

SearchAPI.registerSearchDocumentProducer('meeting', _produceMeetingSearchDocuments);

///////////////////////////
// DOCUMENT TRANSFORMERS //
///////////////////////////

/**
 * Given an array of meeting search documents, transform them into search documents suitable to be displayed to the user in context.
 *
 * @param  {Context}   ctx             Standard context object containing the current user and the current tenant
 * @param  {Object}    docs            A hash, keyed by the document id, while the value is the document to transform
 * @param  {Function}  callback        Standard callback function
 * @param  {Object}    callback.err    An error that occurred, if any
 * @param  {Object}    callback.docs   The transformed docs, in the same form as the `docs` parameter.
 * @api private
 */
var _transformMeetingDocuments = function(ctx, docs, callback) {
    var transformedDocs = {};
    _.each(docs, function(doc, docId) {
        // Extract the extra object from the search document
        var extra = _.first(doc.fields._extra) || {};

        // Build the transformed result document from the ElasticSearch document
        var result = {'id': docId};
        _.each(doc.fields, function(value, name) {
            // Apply the scalar values wrapped in each ElasticSearch document
            // to the transformed search document
            result[name] = _.first(value);
        });

        // Take just the `lastModified` from the extra fields, if specified
        _.extend(result, _.pick(extra, 'lastModified'));

        // Add the full tenant object and profile path
        _.extend(result, {
            'tenant': TenantsAPI.getTenant(result.tenantAlias).compact(),
            'profilePath': util.format('/meeting/%s/%s', result.tenantAlias, AuthzUtil.getResourceFromId(result.id).resourceId)
        });

        transformedDocs[docId] = result;
    });

    return callback(null, transformedDocs);
};

// Bind the transformer to the search API
SearchAPI.registerSearchDocumentTransformer('meeting', _transformMeetingDocuments);

/////////////////////////
// REINDEX ALL HANDLER //
/////////////////////////

SearchAPI.registerReindexAllHandler('meeting', function(callback) {

    /*!
     * Handles each iteration of the MeetingDAO iterate all method, firing tasks for all meetings to
     * be reindexed.
     *
     * @see MeetingDAO#iterateAll
     * @api private
     */
    var _onEach = function(meetingRows, done) {
        // Batch up this iteration of task resources
        var meetingResources = [];
        _.each(meetingRows, function(meetingRow) {
            meetingResources.push({'id': meetingRow.id});
        });

        log().info('Firing re-indexing task for %s meetings.', meetingResources.length);

        SearchAPI.postIndexTask('meeting', meetingResources, {'resource': true, 'children': true});

        done();
    };

    MeetingsDAO.iterateAll(['id'], 100, _onEach, callback);
});
