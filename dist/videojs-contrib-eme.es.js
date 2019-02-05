/*! @name videojs-contrib-eme @version 3.4.1 @license Apache-2.0 */
import videojs from 'video.js';
import window from 'global/window';
import document from 'global/document';

/**
 * Parses the EME key message XML to extract HTTP headers and the Challenge element to use
 * in the PlayReady license request.
 *
 * @param {ArrayBuffer} message key message from EME
 * @return {Object} an object containing headers and the message body to use in the
 * license request
 */

var getMessageContents = function getMessageContents(message) {
  var xml = new window.DOMParser().parseFromString( // TODO do we want to support UTF-8?
  String.fromCharCode.apply(null, new Uint16Array(message)), 'application/xml');
  var headersElement = xml.getElementsByTagName('HttpHeaders')[0];
  var headers = {};

  if (headersElement) {
    var headerNames = headersElement.getElementsByTagName('name');
    var headerValues = headersElement.getElementsByTagName('value');

    for (var i = 0; i < headerNames.length; i++) {
      headers[headerNames[i].childNodes[0].nodeValue] = headerValues[i].childNodes[0].nodeValue;
    }
  }

  var challengeElement = xml.getElementsByTagName('Challenge')[0];
  var challenge;

  if (challengeElement) {
    challenge = window.atob(challengeElement.childNodes[0].nodeValue);
  }

  return {
    headers: headers,
    message: challenge
  };
};
var requestPlayreadyLicense = function requestPlayreadyLicense(url, messageBuffer, callback) {
  var _getMessageContents = getMessageContents(messageBuffer),
      headers = _getMessageContents.headers,
      message = _getMessageContents.message;

  videojs.xhr({
    uri: url,
    method: 'post',
    headers: headers,
    body: message,
    responseType: 'arraybuffer'
  }, callback);
};

var getSupportedKeySystem = function getSupportedKeySystem(keySystems) {
  // As this happens after the src is set on the video, we rely only on the set src (we
  // do not change src based on capabilities of the browser in this plugin).
  var promise;
  Object.keys(keySystems).forEach(function (keySystem) {
    // TODO use initDataTypes when appropriate
    var systemOptions = {};
    var audioContentType = keySystems[keySystem].audioContentType;
    var videoContentType = keySystems[keySystem].videoContentType;

    if (audioContentType) {
      systemOptions.audioCapabilities = [{
        contentType: audioContentType
      }];
    }

    if (videoContentType) {
      systemOptions.videoCapabilities = [{
        contentType: videoContentType
      }];
    }

    if (!promise) {
      promise = window.navigator.requestMediaKeySystemAccess(keySystem, [systemOptions]);
    } else {
      promise = promise.catch(function (e) {
        return window.navigator.requestMediaKeySystemAccess(keySystem, [systemOptions]);
      });
    }
  });
  return promise;
};
var makeNewRequest = function makeNewRequest(_ref) {
  var mediaKeys = _ref.mediaKeys,
      initDataType = _ref.initDataType,
      initData = _ref.initData,
      options = _ref.options,
      getLicense = _ref.getLicense,
      removeSession = _ref.removeSession,
      eventBus = _ref.eventBus;
  var keySession = mediaKeys.createSession();
  keySession.addEventListener('message', function (event) {
    getLicense(options, event.message).then(function (license) {
      return keySession.update(license);
    }).catch(videojs.log.error.bind(videojs.log.error, 'failed to get and set license'));
  }, false);
  keySession.addEventListener('keystatuseschange', function (event) {
    var expired = false; // based on https://www.w3.org/TR/encrypted-media/#example-using-all-events

    keySession.keyStatuses.forEach(function (status, keyId) {
      // Trigger an event so that outside listeners can take action if appropriate.
      // For instance, the `output-restricted` status should result in an
      // error being thrown.
      eventBus.trigger({
        keyId: keyId,
        status: status,
        target: keySession,
        type: 'keystatuschange'
      });

      switch (status) {
        case 'expired':
          // If one key is expired in a session, all keys are expired. From
          // https://www.w3.org/TR/encrypted-media/#dom-mediakeystatus-expired, "All other
          // keys in the session must have this status."
          expired = true;
          break;

        case 'internal-error':
          // "This value is not actionable by the application."
          // https://www.w3.org/TR/encrypted-media/#dom-mediakeystatus-internal-error
          videojs.log.warn('Key status reported as "internal-error." Leaving the session open since we ' + 'don\'t have enough details to know if this error is fatal.', event);
          break;
      }
    });

    if (expired) {
      // Close session and remove it from the session list to ensure that a new
      // session can be created.
      //
      // TODO convert to videojs.log.debug and add back in
      // https://github.com/videojs/video.js/pull/4780
      // videojs.log.debug('Session expired, closing the session.');
      keySession.close().then(function () {
        removeSession(initData);
      });
    }
  }, false);
  keySession.generateRequest(initDataType, initData).catch(videojs.log.error.bind(videojs.log.error, 'Unable to create or initialize key session'));
};

var addSession = function addSession(_ref2) {
  var video = _ref2.video,
      initDataType = _ref2.initDataType,
      initData = _ref2.initData,
      options = _ref2.options,
      getLicense = _ref2.getLicense,
      removeSession = _ref2.removeSession,
      eventBus = _ref2.eventBus;

  if (video.mediaKeysObject) {
    makeNewRequest({
      mediaKeys: video.mediaKeysObject,
      initDataType: initDataType,
      initData: initData,
      options: options,
      getLicense: getLicense,
      removeSession: removeSession,
      eventBus: eventBus
    });
  } else {
    video.pendingSessionData.push({
      initDataType: initDataType,
      initData: initData
    });
  }
};

var setMediaKeys = function setMediaKeys(_ref3) {
  var video = _ref3.video,
      certificate = _ref3.certificate,
      createdMediaKeys = _ref3.createdMediaKeys,
      options = _ref3.options,
      getLicense = _ref3.getLicense,
      removeSession = _ref3.removeSession,
      eventBus = _ref3.eventBus;
  video.mediaKeysObject = createdMediaKeys;

  if (certificate) {
    createdMediaKeys.setServerCertificate(certificate);
  }

  for (var i = 0; i < video.pendingSessionData.length; i++) {
    var data = video.pendingSessionData[i];
    makeNewRequest({
      mediaKeys: video.mediaKeysObject,
      initDataType: data.initDataType,
      initData: data.initData,
      options: options,
      getLicense: getLicense,
      removeSession: removeSession,
      eventBus: eventBus
    });
  }

  video.pendingSessionData = [];
  return video.setMediaKeys(createdMediaKeys);
};

var defaultPlayreadyGetLicense = function defaultPlayreadyGetLicense(url) {
  return function (emeOptions, keyMessage, callback) {
    requestPlayreadyLicense(url, keyMessage, function (err, response, responseBody) {
      if (err) {
        callback(err);
        return;
      }

      callback(null, responseBody);
    });
  };
};

var defaultGetLicense = function defaultGetLicense(url) {
  return function (emeOptions, keyMessage, callback) {
    videojs.xhr({
      uri: url,
      method: 'POST',
      responseType: 'arraybuffer',
      body: keyMessage,
      headers: {
        'Content-type': 'application/octet-stream'
      }
    }, function (err, response, responseBody) {
      if (err) {
        callback(err);
        return;
      }

      callback(null, responseBody);
    });
  };
};

var promisifyGetLicense = function promisifyGetLicense(getLicenseFn, eventBus) {
  return function (emeOptions, keyMessage) {
    return new Promise(function (resolve, reject) {
      getLicenseFn(emeOptions, keyMessage, function (err, license) {
        if (eventBus) {
          eventBus.trigger('licenserequestattempted');
        }

        if (err) {
          reject(err);
        }

        resolve(license);
      });
    });
  };
};

var standardizeKeySystemOptions = function standardizeKeySystemOptions(keySystem, keySystemOptions) {
  if (typeof keySystemOptions === 'string') {
    keySystemOptions = {
      url: keySystemOptions
    };
  }

  if (!keySystemOptions.url && !keySystemOptions.getLicense) {
    throw new Error('Neither URL nor getLicense function provided to get license');
  }

  if (keySystemOptions.url && !keySystemOptions.getLicense) {
    keySystemOptions.getLicense = keySystem === 'com.microsoft.playready' ? defaultPlayreadyGetLicense(keySystemOptions.url) : defaultGetLicense(keySystemOptions.url);
  }

  return keySystemOptions;
};

var standard5July2016 = function standard5July2016(_ref4) {
  var video = _ref4.video,
      initDataType = _ref4.initDataType,
      initData = _ref4.initData,
      options = _ref4.options,
      removeSession = _ref4.removeSession,
      eventBus = _ref4.eventBus;
  var keySystemPromise = Promise.resolve();

  if (typeof video.mediaKeysObject === 'undefined') {
    // Prevent entering this path again.
    video.mediaKeysObject = null; // Will store all initData until the MediaKeys is ready.

    video.pendingSessionData = [];
    var certificate;
    var keySystemOptions;
    keySystemPromise = getSupportedKeySystem(options.keySystems);

    if (!keySystemPromise) {
      videojs.log.error('No supported key system found');
      return Promise.resolve();
    }

    keySystemPromise = keySystemPromise.then(function (keySystemAccess) {
      return new Promise(function (resolve, reject) {
        // save key system for adding sessions
        video.keySystem = keySystemAccess.keySystem;
        keySystemOptions = standardizeKeySystemOptions(keySystemAccess.keySystem, options.keySystems[keySystemAccess.keySystem]);

        if (!keySystemOptions.getCertificate) {
          resolve(keySystemAccess);
          return;
        }

        keySystemOptions.getCertificate(options, function (err, cert) {
          if (err) {
            reject(err);
            return;
          }

          certificate = cert;
          resolve(keySystemAccess);
        });
      });
    }).then(function (keySystemAccess) {
      return keySystemAccess.createMediaKeys();
    }).then(function (createdMediaKeys) {
      return setMediaKeys({
        video: video,
        certificate: certificate,
        createdMediaKeys: createdMediaKeys,
        options: options,
        getLicense: promisifyGetLicense(keySystemOptions.getLicense, eventBus),
        removeSession: removeSession,
        eventBus: eventBus
      });
    }).catch(videojs.log.error.bind(videojs.log.error, 'Failed to create and initialize a MediaKeys object'));
  }

  return keySystemPromise.then(function () {
    addSession({
      video: video,
      initDataType: initDataType,
      initData: initData,
      options: options,
      // if key system has not been determined then addSession doesn't need getLicense
      getLicense: video.keySystem ? promisifyGetLicense(standardizeKeySystemOptions(video.keySystem, options.keySystems[video.keySystem]).getLicense, eventBus) : null,
      removeSession: removeSession,
      eventBus: eventBus
    });
  });
};

var stringToUint16Array = function stringToUint16Array(string) {
  // 2 bytes for each char
  var buffer = new ArrayBuffer(string.length * 2);
  var array = new Uint16Array(buffer);

  for (var i = 0; i < string.length; i++) {
    array[i] = string.charCodeAt(i);
  }

  return array;
};
var uint8ArrayToString = function uint8ArrayToString(array) {
  return String.fromCharCode.apply(null, new Uint16Array(array.buffer));
};
var getHostnameFromUri = function getHostnameFromUri(uri) {
  var link = document.createElement('a');
  link.href = uri;
  return link.hostname;
};
var arrayBuffersEqual = function arrayBuffersEqual(arrayBuffer1, arrayBuffer2) {
  if (arrayBuffer1 === arrayBuffer2) {
    return true;
  }

  if (arrayBuffer1.byteLength !== arrayBuffer2.byteLength) {
    return false;
  }

  var dataView1 = new DataView(arrayBuffer1);
  var dataView2 = new DataView(arrayBuffer2);

  for (var i = 0; i < dataView1.byteLength; i++) {
    if (dataView1.getUint8(i) !== dataView2.getUint8(i)) {
      return false;
    }
  }

  return true;
};
var arrayBufferFrom = function arrayBufferFrom(bufferOrTypedArray) {
  if (bufferOrTypedArray instanceof Uint8Array || bufferOrTypedArray instanceof Uint16Array) {
    return bufferOrTypedArray.buffer;
  }

  return bufferOrTypedArray;
};

var FAIRPLAY_KEY_SYSTEM = 'com.apple.fps.1_0';

var concatInitDataIdAndCertificate = function concatInitDataIdAndCertificate(_ref) {
  var initData = _ref.initData,
      id = _ref.id,
      cert = _ref.cert;

  if (typeof id === 'string') {
    id = stringToUint16Array(id);
  } // layout:
  //   [initData]
  //   [4 byte: idLength]
  //   [idLength byte: id]
  //   [4 byte:certLength]
  //   [certLength byte: cert]


  var offset = 0;
  var buffer = new ArrayBuffer(initData.byteLength + 4 + id.byteLength + 4 + cert.byteLength);
  var dataView = new DataView(buffer);
  var initDataArray = new Uint8Array(buffer, offset, initData.byteLength);
  initDataArray.set(initData);
  offset += initData.byteLength;
  dataView.setUint32(offset, id.byteLength, true);
  offset += 4;
  var idArray = new Uint16Array(buffer, offset, id.length);
  idArray.set(id);
  offset += idArray.byteLength;
  dataView.setUint32(offset, cert.byteLength, true);
  offset += 4;
  var certArray = new Uint8Array(buffer, offset, cert.byteLength);
  certArray.set(cert);
  return new Uint8Array(buffer, 0, buffer.byteLength);
};

var addKey = function addKey(_ref2) {
  var video = _ref2.video,
      contentId = _ref2.contentId,
      initData = _ref2.initData,
      cert = _ref2.cert,
      options = _ref2.options,
      getLicense = _ref2.getLicense,
      eventBus = _ref2.eventBus;
  return new Promise(function (resolve, reject) {
    if (!video.webkitKeys) {
      video.webkitSetMediaKeys(new window.WebKitMediaKeys(FAIRPLAY_KEY_SYSTEM));
    }

    if (!video.webkitKeys) {
      reject('Could not create MediaKeys');
      return;
    }

    var keySession = video.webkitKeys.createSession('video/mp4', concatInitDataIdAndCertificate({
      id: contentId,
      initData: initData,
      cert: cert
    }));

    if (!keySession) {
      reject('Could not create key session');
      return;
    }

    keySession.contentId = contentId;
    keySession.addEventListener('webkitkeymessage', function (event) {
      getLicense(options, contentId, event.message, keySession, function (err, license) {
        if (eventBus) {
          eventBus.trigger('licenserequestattempted');
        }

        if (err) {
          reject(err);
          return;
        }

        keySession.update(new Uint8Array(license));
      });
    });
    keySession.addEventListener('webkitkeyadded', function (event) {
      resolve(event);
    }); // for testing purposes, adding webkitkeyerror must be the last item in this method

    keySession.addEventListener('webkitkeyerror', function (event) {
      reject(event);
    });
  });
};

var defaultGetCertificate = function defaultGetCertificate(certificateUri) {
  return function (emeOptions, callback) {
    videojs.xhr({
      uri: certificateUri,
      responseType: 'arraybuffer'
    }, function (err, response, responseBody) {
      if (err) {
        callback(err);
        return;
      }

      callback(null, new Uint8Array(responseBody));
    });
  };
};

var defaultGetContentId = function defaultGetContentId(emeOptions, initData) {
  return getHostnameFromUri(uint8ArrayToString(initData));
};

var defaultGetLicense$1 = function defaultGetLicense(licenseUri) {
  return function (emeOptions, contentId, keyMessage, keySession, callback) {
    videojs.xhr({
      uri: licenseUri,
      method: 'POST',
      responseType: 'arraybuffer',
      body: keyMessage,
      headers: {
        'Content-type': 'application/octet-stream'
      }
    }, function (err, response, responseBody) {
      if (err) {
        callback(err);
        return;
      }

      callback(null, responseBody);
    });
  };
};

var fairplay = function fairplay(_ref3) {
  var video = _ref3.video,
      initData = _ref3.initData,
      options = _ref3.options,
      eventBus = _ref3.eventBus;
  var fairplayOptions = options.keySystems[FAIRPLAY_KEY_SYSTEM];
  var getCertificate = fairplayOptions.getCertificate || defaultGetCertificate(fairplayOptions.certificateUri);
  var getContentId = fairplayOptions.getContentId || defaultGetContentId;
  var getLicense = fairplayOptions.getLicense || defaultGetLicense$1(fairplayOptions.licenseUri);
  return new Promise(function (resolve, reject) {
    getCertificate(options, function (err, cert) {
      if (err) {
        reject(err);
        return;
      }

      resolve(cert);
    });
  }).then(function (cert) {
    return addKey({
      video: video,
      cert: cert,
      initData: initData,
      getLicense: getLicense,
      options: options,
      contentId: getContentId(options, initData),
      eventBus: eventBus
    });
  }).catch(videojs.log.error.bind(videojs.log.error));
};

var PLAYREADY_KEY_SYSTEM = 'com.microsoft.playready';
var addKeyToSession = function addKeyToSession(options, session, event, eventBus) {
  var playreadyOptions = options.keySystems[PLAYREADY_KEY_SYSTEM];

  if (typeof playreadyOptions.getKey === 'function') {
    playreadyOptions.getKey(options, event.destinationURL, event.message.buffer, function (err, key) {
      if (err) {
        videojs.log.error('Unable to get key: ' + err);
        return;
      }

      session.update(key);
    });
    return;
  }

  if (typeof playreadyOptions === 'string') {
    playreadyOptions = {
      url: playreadyOptions
    };
  }

  var url = playreadyOptions.url || event.destinationURL;
  requestPlayreadyLicense(url, event.message.buffer, function (err, response) {
    if (eventBus) {
      eventBus.trigger('licenserequestattempted');
    }

    if (err) {
      videojs.log.error('Unable to request key from url: ' + url);
      return;
    }

    session.update(new Uint8Array(response.body));
  });
};
var createSession = function createSession(video, initData, options, eventBus) {
  var session = video.msKeys.createSession('video/mp4', initData);

  if (!session) {
    videojs.log.error('Could not create key session.');
    return;
  } // Note that mskeymessage may not always be called for PlayReady:
  //
  // "If initData contains a PlayReady object that contains an OnDemand header, only a
  // keyAdded event is returned (as opposed to a keyMessage event as described in the
  // Encrypted Media Extension draft). Similarly, if initData contains a PlayReady object
  // that contains a key identifier in the hashed data storage (HDS), only a keyAdded
  // event is returned."
  // eslint-disable-next-line max-len
  // @see [PlayReady License Acquisition]{@link https://msdn.microsoft.com/en-us/library/dn468979.aspx}


  session.addEventListener('mskeymessage', function (event) {
    addKeyToSession(options, session, event, eventBus);
  });
  session.addEventListener('mskeyerror', function (event) {
    videojs.log.error('Unexpected key error from key session with ' + ("code: " + session.error.code + " and systemCode: " + session.error.systemCode));
  });
};
var msPrefixed = (function (_ref) {
  var video = _ref.video,
      initData = _ref.initData,
      options = _ref.options,
      eventBus = _ref.eventBus;

  // Although by the standard examples the presence of video.msKeys is checked first to
  // verify that we aren't trying to create a new session when one already exists, here
  // sessions are managed earlier (on the player.eme object), meaning that at this point
  // any existing keys should be cleaned up.
  if (video.msKeys) {
    delete video.msKeys;
  }

  try {
    video.msSetMediaKeys(new window.MSMediaKeys(PLAYREADY_KEY_SYSTEM));
  } catch (e) {
    videojs.log.error('Unable to create media keys for PlayReady key system. Error: ' + e.message);
    return;
  }

  createSession(video, initData, options, eventBus);
});

var hasSession = function hasSession(sessions, initData) {
  for (var i = 0; i < sessions.length; i++) {
    // Other types of sessions may be in the sessions array that don't store the initData
    // (for instance, PlayReady sessions on IE11).
    if (!sessions[i].initData) {
      continue;
    } // initData should be an ArrayBuffer by the spec:
    // eslint-disable-next-line max-len
    // @see [Media Encrypted Event initData Spec]{@link https://www.w3.org/TR/encrypted-media/#mediaencryptedeventinit}
    //
    // However, on some browsers it may come back with a typed array view of the buffer.
    // This is the case for IE11, however, since IE11 sessions are handled differently
    // (following the msneedkey PlayReady path), this coversion may not be important. It
    // is safe though, and might be a good idea to retain in the short term (until we have
    // catalogued the full range of browsers and their implementations).


    var sessionBuffer = arrayBufferFrom(sessions[i].initData);
    var initDataBuffer = arrayBufferFrom(initData);

    if (arrayBuffersEqual(sessionBuffer, initDataBuffer)) {
      return true;
    }
  }

  return false;
};
var removeSession = function removeSession(sessions, initData) {
  for (var i = 0; i < sessions.length; i++) {
    if (sessions[i].initData === initData) {
      sessions.splice(i, 1);
      return;
    }
  }
};
var handleEncryptedEvent = function handleEncryptedEvent(event, options, sessions, eventBus) {
  if (!options || !options.keySystems) {
    // return silently since it may be handled by a different system
    return Promise.resolve();
  }

  var initData = event.initData;
  return getSupportedKeySystem(options.keySystems).then(function (_ref) {
    var keySystem = _ref.keySystem;

    // Use existing init data from options if provided
    if (options.keySystems[keySystem] && options.keySystems[keySystem].pssh) {
      initData = options.keySystems[keySystem].pssh;
    } // "Initialization Data must be a fixed value for a given set of stream(s) or media
    // data. It must only contain information related to the keys required to play a given
    // set of stream(s) or media data."
    // eslint-disable-next-line max-len
    // @see [Initialization Data Spec]{@link https://www.w3.org/TR/encrypted-media/#initialization-data}


    if (hasSession(sessions, initData) || !initData) {
      // TODO convert to videojs.log.debug and add back in
      // https://github.com/videojs/video.js/pull/4780
      // videojs.log('eme',
      //             'Already have a configured session for init data, ignoring event.');
      return;
    }

    sessions.push({
      initData: initData
    });
    return standard5July2016({
      video: event.target,
      initDataType: event.initDataType,
      initData: initData,
      options: options,
      removeSession: removeSession.bind(null, sessions),
      eventBus: eventBus
    });
  });
};
var handleWebKitNeedKeyEvent = function handleWebKitNeedKeyEvent(event, options, eventBus) {
  if (!options.keySystems || !options.keySystems[FAIRPLAY_KEY_SYSTEM] || !event.initData) {
    // return silently since it may be handled by a different system
    return;
  } // From Apple's example Safari FairPlay integration code, webkitneedkey is not repeated
  // for the same content. Unless documentation is found to present the opposite, handle
  // all webkitneedkey events the same (even if they are repeated).


  return fairplay({
    video: event.target,
    initData: event.initData,
    options: options,
    eventBus: eventBus
  });
};
var handleMsNeedKeyEvent = function handleMsNeedKeyEvent(event, options, sessions, eventBus) {
  if (!options.keySystems || !options.keySystems[PLAYREADY_KEY_SYSTEM]) {
    // return silently since it may be handled by a different system
    return;
  } // "With PlayReady content protection, your Web app must handle the first needKey event,
  // but it must then ignore any other needKey event that occurs."
  // eslint-disable-next-line max-len
  // @see [PlayReady License Acquisition]{@link https://msdn.microsoft.com/en-us/library/dn468979.aspx}
  //
  // Usually (and as per the example in the link above) this is determined by checking for
  // the existence of video.msKeys. However, since the video element may be reused, it's
  // easier to directly manage the session.


  if (sessions.reduce(function (acc, session) {
    return acc || session.playready;
  }, false)) {
    // TODO convert to videojs.log.debug and add back in
    // https://github.com/videojs/video.js/pull/4780
    // videojs.log('eme',
    //             'An \'msneedkey\' event was receieved earlier, ignoring event.');
    return;
  }

  var initData = event.initData; // Use existing init data from options if provided

  if (options.keySystems[PLAYREADY_KEY_SYSTEM] && options.keySystems[PLAYREADY_KEY_SYSTEM].pssh) {
    initData = options.keySystems[PLAYREADY_KEY_SYSTEM].pssh;
  }

  if (!initData) {
    return;
  }

  sessions.push({
    playready: true,
    initData: initData
  });
  msPrefixed({
    video: event.target,
    initData: initData,
    options: options,
    eventBus: eventBus
  });
};
var getOptions = function getOptions(player) {
  return videojs.mergeOptions(player.currentSource(), player.eme.options);
};
/**
 * Configure a persistent sessions array and activeSrc property to ensure we properly
 * handle each independent source's events. Should be run on any encrypted or needkey
 * style event to ensure that the sessions reflect the active source.
 *
 * @function setupSessions
 * @param    {Player} player
 */

var setupSessions = function setupSessions(player) {
  var src = player.src();

  if (src !== player.eme.activeSrc) {
    player.eme.activeSrc = src;
    player.eme.sessions = [];
  }
};
/**
 * Function to invoke when the player is ready.
 *
 * This is a great place for your plugin to initialize itself. When this
 * function is called, the player will have its DOM and child components
 * in place.
 *
 * @function onPlayerReady
 * @param    {Player} player
 * @param    {Object} [options={}]
 */

var onPlayerReady = function onPlayerReady(player) {
  if (player.$('.vjs-tech').tagName.toLowerCase() !== 'video') {
    return;
  }

  setupSessions(player); // Support EME 05 July 2016
  // Chrome 42+, Firefox 47+, Edge

  player.tech_.el_.addEventListener('encrypted', function (event) {
    // TODO convert to videojs.log.debug and add back in
    // https://github.com/videojs/video.js/pull/4780
    // videojs.log('eme', 'Received an \'encrypted\' event');
    setupSessions(player);
    handleEncryptedEvent(event, getOptions(player), player.eme.sessions, player.tech_);
  }); // Support Safari EME with FairPlay
  // (also used in early Chrome or Chrome with EME disabled flag)

  player.tech_.el_.addEventListener('webkitneedkey', function (event) {
    // TODO convert to videojs.log.debug and add back in
    // https://github.com/videojs/video.js/pull/4780
    // videojs.log('eme', 'Received a \'webkitneedkey\' event');
    // TODO it's possible that the video state must be cleared if reusing the same video
    // element between sources
    setupSessions(player);
    handleWebKitNeedKeyEvent(event, getOptions(player), player.tech_);
  }); // EDGE still fires msneedkey, but should use encrypted instead

  if (videojs.browser.IS_EDGE) {
    return;
  } // IE11 Windows 8.1+


  player.tech_.el_.addEventListener('msneedkey', function (event) {
    // TODO convert to videojs.log.debug and add back in
    // https://github.com/videojs/video.js/pull/4780
    // videojs.log('eme', 'Received an \'msneedkey\' event');
    setupSessions(player);
    handleMsNeedKeyEvent(event, getOptions(player), player.eme.sessions, player.tech_);
  });
};
/**
 * A video.js plugin.
 *
 * In the plugin function, the value of `this` is a video.js `Player`
 * instance. You cannot rely on the player being in a "ready" state here,
 * depending on how the plugin is invoked. This may or may not be important
 * to you; if not, remove the wait for "ready"!
 *
 * @function eme
 * @param    {Object} [options={}]
 *           An object of options left to the plugin author to define.
 */


var eme = function eme(options) {
  if (options === void 0) {
    options = {};
  }

  var player = this;
  player.ready(function () {
    return onPlayerReady(player);
  }); // Plugin API

  player.eme = {
    /**
    * Sets up MediaKeys on demand
    * Works around https://bugs.chromium.org/p/chromium/issues/detail?id=895449
    *
    * @function initializeMediaKeys
    * @param    {Object} [emeOptions={}]
    *           An object of eme plugin options.
    * @param    {Function} [callback=function(){}]
    */
    initializeMediaKeys: function initializeMediaKeys(emeOptions, callback) {
      if (emeOptions === void 0) {
        emeOptions = {};
      }

      if (callback === void 0) {
        callback = function callback() {};
      }

      // TODO: this should be refactored and renamed to be less tied
      // to encrypted events
      var mergedEmeOptions = videojs.mergeOptions(player.currentSource(), options, emeOptions); // fake an encrypted event for handleEncryptedEvent

      var mockEncryptedEvent = {
        initDataType: 'cenc',
        initData: null,
        target: player.tech_.el_
      };
      setupSessions(player);

      if (player.tech_.el_.setMediaKeys) {
        handleEncryptedEvent(mockEncryptedEvent, mergedEmeOptions, player.eme.sessions, player.tech_).then(function () {
          return callback();
        }).catch(function (error) {
          return callback(error);
        });
      } else if (player.tech_.el_.msSetMediaKeys) {
        handleMsNeedKeyEvent(mockEncryptedEvent, mergedEmeOptions, player.eme.sessions, player.tech_);
        callback();
      }
    },
    options: options
  };
}; // Register the plugin with video.js.


var registerPlugin = videojs.registerPlugin || videojs.plugin;
registerPlugin('eme', eme);

export default eme;
export { hasSession, removeSession, handleEncryptedEvent, handleWebKitNeedKeyEvent, handleMsNeedKeyEvent, getOptions, setupSessions };
