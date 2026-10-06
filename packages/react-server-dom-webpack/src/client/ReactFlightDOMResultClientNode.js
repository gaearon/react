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
import type {ClientManifest} from '../server/ReactFlightServerConfigWebpackBundler';
import type {
  ServerConsumerModuleMap,
  ModuleLoading,
  ServerManifest,
} from 'react-client/src/ReactFlightClientConfig';

import {
  createResponse,
  readResult,
} from 'react-client/src/ReactFlightResultClient';
import {getRoot} from 'shared/ReactFlightResult';
import {
  isClientReference,
  resolveClientReferenceMetadata,
} from '../server/ReactFlightServerConfigWebpackBundler';

type Options = {
  clientManifest: ClientManifest,
  serverConsumerManifest: {
    moduleMap: ServerConsumerModuleMap,
    moduleLoading: ModuleLoading,
    serverModuleMap: null | ServerManifest,
  },
  nonce?: string,
};

export function createFromResult<T>(
  result: Result<T>,
  options?: Options,
): Thenable<T> {
  if (options === undefined) {
    return getRoot(result);
  }
  const clientManifest = options.clientManifest;
  const serverConsumerManifest = options.serverConsumerManifest;
  const response = createResponse(
    result,
    serverConsumerManifest.moduleMap,
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
    options.nonce,
  );
  return readResult(response, result);
}
