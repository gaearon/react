/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import type {ReactClientValue} from 'react-server/src/ReactFlightResultServer';
import type {Result} from 'shared/ReactFlightResult';
export type {Result} from 'shared/ReactFlightResult';
import {
  createRequest,
  getResult,
  startWork,
} from 'react-server/src/ReactFlightResultServer';

type Options = {
  onError?: (error: mixed) => ?string,
  identifierPrefix?: string,
};

export function renderToResult(
  model: ReactClientValue,
  options?: Options,
): Result<ReactClientValue> {
  const request = createRequest(
    model,
    options ? options.onError : undefined,
    options ? options.identifierPrefix : undefined,
  );
  startWork(request);
  return getResult(request);
}
