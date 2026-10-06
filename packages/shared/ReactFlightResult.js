/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import noop from './noop';

// Result is a producer handle, not a thenable. Only the reader exposes its root.
export opaque type Result<T>: {abort(reason: mixed): void, ...} = {
  +root: Promise<T>,
  +errorDigests: WeakMap<Object, string>,
  abort(reason: mixed): void,
};

export function createResult<T>(
  root: Promise<T>,
  abort: (reason: mixed) => void,
): Result<T> {
  // Rendering can fail before a reader subscribes. Keep the original rejection
  // available to the reader without reporting an unhandled promise rejection.
  root.catch(noop);
  return {root, abort, errorDigests: new WeakMap()};
}

export function getRoot<T>(result: Result<T>): Promise<T> {
  return result.root;
}

export function setErrorDigest<T>(
  result: Result<T>,
  thenable: Object,
  digest: string,
): void {
  result.errorDigests.set(thenable, digest);
}

export function getErrorDigest<T>(
  result: Result<T>,
  thenable: Object,
): void | string {
  return result.errorDigests.get(thenable);
}
