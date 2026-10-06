/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import type {
  Request,
  ReactClientValue,
} from 'react-server/src/ReactFlightResultServer';
import type {ClientManifest} from './ReactFlightServerConfigWebpackBundler';
import type {Writable} from 'stream';
import {
  createRequest,
  startWork,
  startFlowing,
  stopFlowing,
  abort,
} from 'react-server/src/ReactFlightResultServer';

type Options = {
  onError?: (error: mixed) => ?string,
  identifierPrefix?: string,
};

// The initial Result implementation preserves the copied Flight transport.
// Consumers use createFromResult; the transport can change behind these APIs.
export type Result = {
  abort(reason: mixed): void,
  pipe<T: Writable>(destination: T): T,
};

function createCancelHandler(request: Request, reason: string) {
  return () => {
    stopFlowing(request);
    abort(request, new Error(reason));
  };
}

export function renderToResult(
  model: ReactClientValue,
  webpackMap: ClientManifest,
  options?: Options,
): Result {
  const request = createRequest(
    model,
    webpackMap,
    options ? options.onError : undefined,
    options ? options.identifierPrefix : undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    false,
  );
  let hasStartedFlowing = false;
  startWork(request);
  return {
    pipe<T: Writable>(destination: T): T {
      if (hasStartedFlowing) {
        throw new Error(
          'React currently only supports piping to one writable stream.',
        );
      }
      hasStartedFlowing = true;
      startFlowing(request, destination);
      destination.on('drain', () => startFlowing(request, destination));
      destination.on(
        'error',
        createCancelHandler(
          request,
          'The destination stream errored while writing data.',
        ),
      );
      destination.on(
        'close',
        createCancelHandler(request, 'The destination stream closed early.'),
      );
      return destination;
    },
    abort(reason: mixed) {
      abort(request, reason);
    },
  };
}
