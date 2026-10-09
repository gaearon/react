/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import type {Thenable} from 'shared/ReactTypes';
import type {Result} from 'shared/ReactFlightResult';
import type {FindSourceMapURLCallback} from 'react-client/src/ReactFlightClient';
import type {TemporaryReferenceSet} from 'react-client/src/ReactFlightTemporaryReferences';
import type {EncodeFormActionCallback} from 'react-client/src/ReactFlightReplyClient';
import type {ClientManifest} from '../server/ReactFlightServerConfigTurbopackBundler';
import type {
  ServerConsumerModuleMap,
  ModuleLoading,
  ServerManifest,
} from 'react-client/src/ReactFlightClientConfig';

import {
  createResponse,
  readResult,
  stopReading,
  addResponseCleanup,
} from 'react-client/src/ReactFlightResultClient';
import {
  isClientReference,
  resolveClientReferenceMetadata,
} from '../server/ReactFlightServerConfigTurbopackBundler';

function noServerCall() {
  throw new Error(
    'Server Functions cannot be called during initial render. ' +
      'This would create a fetch waterfall. Try to use a Server Component ' +
      'to pass data to Client Components instead.',
  );
}

type Options = {
  clientManifest: ClientManifest,
  serverConsumerManifest: {
    moduleMap: ServerConsumerModuleMap,
    moduleLoading: ModuleLoading,
    serverModuleMap: null | ServerManifest,
  },
  nonce?: string,
  onError?: (mixed) => ?string,
  signal?: AbortSignal,
  encodeFormAction?: EncodeFormActionCallback,
  temporaryReferences?: TemporaryReferenceSet,
  findSourceMapURL?: FindSourceMapURLCallback,
  environmentName?: string,
  unstable_allowPartialStream?: boolean,
};

export function createFromResult<T>(
  result: Result<T>,
  options: Options,
): Thenable<T> {
  const clientManifest = options.clientManifest;
  const serverConsumerManifest = options.serverConsumerManifest;
  const response = createResponse(
    result,
    serverConsumerManifest.moduleMap,
    serverConsumerManifest.serverModuleMap,
    serverConsumerManifest.moduleLoading,
    value => {
      if (!isClientReference(value)) {
        return null;
      }
      return resolveClientReferenceMetadata(
        clientManifest,
        value as any,
      ) as any;
    },
    noServerCall,
    options.encodeFormAction,
    options.nonce,
    options.temporaryReferences,
    __DEV__ && options ? options.findSourceMapURL : undefined,
    __DEV__ && options ? options.environmentName : undefined,
    options.unstable_allowPartialStream === true,
    options.onError,
  );
  const signal = options.signal;
  if (signal !== undefined) {
    const onAbort = () => stopReading(response, signal.reason);
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener('abort', onAbort, {once: true});
      addResponseCleanup(response, () =>
        signal.removeEventListener('abort', onAbort),
      );
    }
  }
  return readResult(response, result);
}
