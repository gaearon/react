/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */
/* eslint-disable import/first */

import * as React from 'react';
import ServerRouter from './ServerRouter';

export default function App(props) {
  return (
    <ServerRouter
      preloadedId="home"
      tabs={[
        {
          id: 'home',
          label: 'Home',
          to: ['FeedPage', {}],
        },
        {
          id: 'profile',
          label: 'Profile',
          to: ['ProfilePage', {userId: 3}],
        },
      ]}
    />
  );
}
