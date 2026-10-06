/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import type {Result} from 'shared/ReactFlightResult';
import {getRoot, getErrorDigest} from 'shared/ReactFlightResult';
import {describeObjectForErrorMessage} from 'shared/ReactSerializationErrors';
import noop from 'shared/noop';
export type Response = {_result: Result<any>};
export function createResponse(result: Result<any>): Response {
  return {_result: result};
}
function resolveError(
  response: Response,
  thenable: Object,
  error: mixed,
): mixed {
  const digest = getErrorDigest(response._result, thenable);
  if (digest === undefined) {
    return error;
  }
  let resolvedError;
  if (__DEV__) {
    let name = 'Error';
    let message;
    let descriptors = null;
    try {
      if (error instanceof Error) {
        name = error.name;
        // eslint-disable-next-line react-internal/safe-string-coercion
        message = String(error.message);
        descriptors = Object.getOwnPropertyDescriptors(error as any);
        delete descriptors.digest;
        delete descriptors.message;
        delete descriptors.name;
      } else if (typeof error === 'object' && error !== null) {
        message = describeObjectForErrorMessage(error);
      } else {
        // eslint-disable-next-line react-internal/safe-string-coercion
        message = String(error);
      }
    } catch (x) {
      message = 'An error occurred but serializing the error message failed.';
      descriptors = null;
    }
    // eslint-disable-next-line react-internal/prod-error-codes
    resolvedError = new Error(message);
    if (descriptors !== null) {
      Object.defineProperties(resolvedError, descriptors);
    }
    resolvedError.name = name;
  } else {
    resolvedError = new Error(
      'An error occurred in the Server Components render. The specific message is omitted in production' +
        ' builds to avoid leaking sensitive details. A digest property is included on this error instance which' +
        ' may provide additional details about the nature of the error.',
    );
    resolvedError.stack = 'Error: ' + resolvedError.message;
  }
  (resolvedError as any).digest = digest;
  return resolvedError;
}

export function readResult<T>(
  response: Response,
  result: Result<T>,
): Promise<T> {
  const root = getRoot(result);
  const promise = root.then(
    model => model,
    error => {
      throw resolveError(response, root, error);
    },
  );
  promise.catch(noop);
  return promise;
}
