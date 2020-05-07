/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import React from 'react';
import {Suspense} from 'react';
import {createCache, CacheProvider} from 'react/unstable-cache';
import {unstable_createRoot as createRoot} from 'react-dom';
import './index.css';
import Frame from './client/Frame';

const initialCache = createCache();
createRoot(document.getElementById('root')).render(
  <Suspense fallback={<h1>Loading...</h1>}>
    <CacheProvider value={initialCache}>
      <Frame src="App" params={{route: '/'}} />
    </CacheProvider>
  </Suspense>
);
