/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import type {ClientManifest} from '../server/ReactFlightServerConfigWebpackBundler';
import type {Thenable} from 'shared/ReactTypes';
import type {Result} from '../server/ReactFlightDOMResultServerNode';
import type {
  ServerConsumerModuleMap,
  ModuleLoading,
  ServerManifest,
} from 'react-client/src/ReactFlightClientConfig';
import {PassThrough} from 'stream';
import {
  createResponse,
  createStreamState,
  getRoot,
  reportGlobalError,
  processStringChunk,
  processBinaryChunk,
  close,
} from 'react-client/src/ReactFlightResultClient';

type ServerConsumerManifest = {
  moduleMap: ServerConsumerModuleMap,
  moduleLoading: ModuleLoading,
  serverModuleMap: null | ServerManifest,
};

type Options = {
  clientManifest: ClientManifest,
  serverConsumerManifest: {
    moduleMap: ServerConsumerModuleMap,
    moduleLoading: ModuleLoading,
    serverModuleMap: null | ServerManifest,
  },
  nonce?: string,
};

function noServerCall() {
  throw new Error(
    'Server Functions cannot be called during initial render. ' +
      'This would create a fetch waterfall. Try to use a Server Component ' +
      'to pass data to Client Components instead.',
  );
}

export function createFromResult<T>(
  result: Result,
  options: Options,
): Thenable<T> {
  const manifest: ServerConsumerManifest = options.serverConsumerManifest;
  const response = createResponse(
    manifest.moduleMap,
    manifest.serverModuleMap,
    manifest.moduleLoading,
    noServerCall,
    undefined,
    undefined,
    undefined,
    false,
    undefined,
    false,
    undefined,
    undefined,
    undefined,
    undefined,
  );
  const stream = new PassThrough();
  const streamState = createStreamState(response, stream);
  stream.on('data', chunk => {
    if (typeof chunk === 'string') {
      processStringChunk(response, streamState, chunk);
    } else {
      processBinaryChunk(response, streamState, chunk);
    }
  });
  stream.on('error', error => reportGlobalError(response, error));
  stream.on('end', () => close(response));
  result.pipe(stream);
  return getRoot(response);
}
