/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import * as React from 'react';

export default function Frame({src, params}) {
  // This is against the rules -- but imagine this reads from an endpoint.
  const ServerComponent = require('../server/' + src + '.js').default;
  return <ServerComponent {...params} />;
}
