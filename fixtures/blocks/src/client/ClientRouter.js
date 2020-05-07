/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import * as React from 'react';
import {
  useState,
  useEffect,
  unstable_useTransition as useTransition,
} from 'react';
import {createCache, readCache, CacheProvider} from 'react/unstable-cache';
import Frame from './Frame';

let waiting = 0;

export default function Router({tabs, preloadedId, preloadedChildren}) {
  const [activeId, setActiveId] = useState(preloadedId);
  const [cacheMap, setCacheMap] = useState(() => ({
    [preloadedId]: readCache(),
  }));
  const [childrenMap, setChildrenMap] = useState(() => ({
    [preloadedId]: preloadedChildren,
  }));

  const [startTransition, isPending] = useTransition({
    timeoutMs: 1500,
  });

  useEffect(() => {
    if (isPending) {
      waiting++;
      document.body.style.cursor = 'wait';
    }
    return () => {
      if (isPending) {
        waiting--;
        if (waiting === 0) {
          document.body.style.cursor = '';
        }
      }
    };
  }, [isPending]);

  function handleClick(tab) {
    const [src, params] = tab.to;
    startTransition(() => {
      const prevActiveId = activeId;
      setActiveId(tab.id);
      const didInvalidate = prevActiveId === tab.id;
      if (!childrenMap[tab.id] || didInvalidate) {
        setChildrenMap({
          ...childrenMap,
          [tab.id]: <Frame src={src} params={params} />,
        });
        setCacheMap({
          ...cacheMap,
          [tab.id]: createCache(),
        });
      }
    });
  }

  return (
    <div
      style={{
        width: '500px',
        height: '500px',
        border: '1px solid',
      }}>
      {tabs.map(tab => (
        <button key={tab.id} onClick={() => handleClick(tab)}>
          {tab.label}
          {tab.id === activeId && ' (active)'}
        </button>
      ))}
      <br />
      {Object.keys(childrenMap).map(id => (
        <CacheProvider value={cacheMap[id]} key={id}>
          {id === activeId ? childrenMap[id] : null}
        </CacheProvider>
      ))}
    </div>
  );
}
