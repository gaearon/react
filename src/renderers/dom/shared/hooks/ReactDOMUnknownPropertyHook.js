/**
 * Copyright 2013-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule ReactDOMUnknownPropertyHook
 */

'use strict';

var DOMProperty = require('DOMProperty');
var EventPluginRegistry = require('EventPluginRegistry');

if (__DEV__) {
  var warning = require('fbjs/lib/warning');
  var {ReactDebugCurrentFrame} = require('ReactGlobalSharedState');
}

function getStackAddendum() {
  var stack = ReactDebugCurrentFrame.getStackAddendum();
  return stack != null ? stack : '';
}

if (__DEV__) {
  var warnedProperties = {};
  var hasOwnProperty = Object.prototype.hasOwnProperty;
  var EVENT_NAME_REGEX = /^on[A-Z]/;
  var ARIA_NAME_REGEX = /^aria-/i;
  var possibleStandardNames = require('possibleStandardNames');

  var validateProperty = function(tagName, name, value) {
    if (hasOwnProperty.call(warnedProperties, name) && warnedProperties[name]) {
      return true;
    }

    if (EventPluginRegistry.registrationNameModules.hasOwnProperty(name)) {
      return true;
    }

    if (
      EventPluginRegistry.plugins.length === 0 &&
      EVENT_NAME_REGEX.test(name)
    ) {
      // If no event plugins have been injected, we might be in a server environment.
      // Don't check events in this case.
      return true;
    }

    var lowerCasedName = name.toLowerCase();
    var registrationName = EventPluginRegistry.possibleRegistrationNames.hasOwnProperty(
      lowerCasedName,
    )
      ? EventPluginRegistry.possibleRegistrationNames[lowerCasedName]
      : null;

    if (registrationName != null) {
      warning(
        false,
        'Unknown event handler property `%s`. Did you mean `%s`?%s',
        name,
        registrationName,
        getStackAddendum(),
      );
      warnedProperties[name] = true;
      return true;
    }

    // Let the ARIA attribute hook validate ARIA attributes
    if (ARIA_NAME_REGEX.test(name)) {
      return true;
    }

    if (lowerCasedName === 'onfocusin' || lowerCasedName === 'onfocusout') {
      warning(
        false,
        'React uses onFocus and onBlur instead of onFocusIn and onFocusOut. ' +
          'All React events are normalized to bubble, so onFocusIn and onFocusOut ' +
          'are not needed/supported by React.',
      );
      warnedProperties[name] = true;
      return true;
    }

    if (lowerCasedName === 'innerhtml') {
      warning(
        false,
        'Directly setting property `innerHTML` is not permitted. ' +
          'For more information, lookup documentation on `dangerouslySetInnerHTML`.',
      );
      warnedProperties[name] = true;
      return true;
    }

    if (typeof value === 'number' && isNaN(value)) {
      warning(
        false,
        'Received NaN for numeric attribute `%s`. If this is expected, cast ' +
          'the value to a string.%s',
        name,
        getStackAddendum(),
      );
      warnedProperties[name] = true;
      return true;
    }

    // Known attributes should match the casing specified in the property config.
    if (possibleStandardNames.hasOwnProperty(lowerCasedName)) {
      var standardName = possibleStandardNames[lowerCasedName];
      if (standardName !== name) {
        warning(
          false,
          'Invalid DOM property `%s`. Did you mean `%s`?%s',
          name,
          standardName,
          getStackAddendum(),
        );
        warnedProperties[name] = true;
        return true;
      }
    }

    // Now that we've validated casing, do not validate
    // data types for reserved props
    if (DOMProperty.isReservedProp(name)) {
      return true;
    }

    // Warn when a known attribute is a bad type
    if (!DOMProperty.shouldSetAttribute(name, value)) {
      warnedProperties[name] = true;
      return false;
    }

    return true;
  };
}

var warnUnknownProperties = function(type, props) {
  var unknownProps = [];
  for (var key in props) {
    var isValid = validateProperty(type, key, props[key]);
    if (!isValid) {
      unknownProps.push(key);
      var value = props[key];
      if (typeof value === 'object' && value !== null) {
        warning(
          false,
          'The %s prop on <%s> is not a known property, and was given an object.' +
            'Remove it, or it will appear in the ' +
            'DOM after a future React update.%s',
          key,
          type,
          getStackAddendum(),
        );
      }
    }
  }

  var unknownPropString = unknownProps.map(prop => '`' + prop + '`').join(', ');

  if (unknownProps.length === 1) {
    warning(
      false,
      'Invalid prop %s on <%s> tag. Either remove this prop from the element, ' +
        'or pass a string or number value to keep it in the DOM. ' +
        'For details, see https://fb.me/react-unknown-prop%s',
      unknownPropString,
      type,
      getStackAddendum(),
    );
  } else if (unknownProps.length > 1) {
    warning(
      false,
      'Invalid props %s on <%s> tag. Either remove these props from the element, ' +
        'or pass a string or number value to keep them in the DOM. ' +
        'For details, see https://fb.me/react-unknown-prop%s',
      unknownPropString,
      type,
      getStackAddendum(),
    );
  }
};

function validateProperties(type, props) {
  if (type.indexOf('-') >= 0 || props.is) {
    return;
  }
  warnUnknownProperties(type, props);
}

var ReactDOMUnknownPropertyHook = {
  validateProperties,
};

module.exports = ReactDOMUnknownPropertyHook;
