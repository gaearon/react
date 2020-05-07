/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import * as React from 'react';
import {Suspense} from 'react';
import {fetch} from 'react-data/fetch';
import ServerRouter from './ServerRouter';

export default function ProfilePage({userId}) {
  const user = fetch(`/users/${userId}`).json();
  return (
    <>
      <h2>{user.name}</h2>
      <Suspense fallback={<h3>Loading...</h3>}>
        <ServerRouter
          preloadedId="timeline"
          tabs={[
            {
              id: 'timeline',
              label: 'Timeline',
              to: ['ProfileTimeline', {userId}],
            },
            {
              id: 'bio',
              label: 'Bio',
              to: ['ProfileBio', {userId}],
            },
          ]}
        />
      </Suspense>
    </>
  );
}
