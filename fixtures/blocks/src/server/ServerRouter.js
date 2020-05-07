/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import * as React from 'react';

import ClientRouter from '../client/ClientRouter';

export default function ServerRouter({tabs, preloadedId, preloadedChildren}) {
  const preloadedTab = tabs.find(tab => tab.id === preloadedId);
  const [src, params] = preloadedTab.to;
  // TODO: register entrypoints somewhere?
  const ServerComponent = require('./' + src + '.js').default;
  return (
    <ClientRouter
      tabs={tabs}
      preloadedId={preloadedId}
      preloadedChildren={<ServerComponent {...params} />}
    />
  );
}
