/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @emails react-core
 * @jest-environment node
 */

'use strict';

import {patchSetImmediate} from '../../../../scripts/jest/patchSetImmediate';

let React;
let ReactServer;
let ReactNoop;
let ReactServerDOMServer;
let ReactServerDOMClient;
let act;
let serverAct;

describe('ReactFlightResult model', () => {
  beforeEach(() => {
    jest.resetModules();
    patchSetImmediate();
    jest.mock('react', () => require('react/react.react-server'));
    ReactServer = require('react');
    ReactServerDOMServer = require('react-server-dom-webpack/server.node');
    serverAct = require('internal-test-utils').serverAct;

    jest.resetModules();
    __unmockReact();
    React = require('react');
    ReactNoop = require('react-noop-renderer');
    ReactServerDOMClient = require('react-server-dom-webpack/client.node');
    act = require('internal-test-utils').act;
  });

  it('preserves a model without Server Components', async () => {
    const model = Object.freeze({
      html: (
        <div>
          <span>hello</span>
        </div>
      ),
      data: Object.freeze([NaN, -0, undefined, '$1', 42]),
    });
    const result = await serverAct(() =>
      ReactServerDOMServer.renderToResult(model),
    );
    expect(result.then).toBe(undefined);
    expect(result.pipe).toBe(undefined);
    const expanded = await ReactServerDOMClient.createFromResult(result);
    expect(expanded).toEqual(model);
  });

  it('expands Server Components and preserves sharing', async () => {
    const unchanged = Object.freeze({text: 'hello'});
    const text = <span>world</span>;
    let calls = 0;
    function Text() {
      calls++;
      return text;
    }
    const child = <Text />;
    const html = <div key="greeting">{child}</div>;
    const shared = {unchanged, text: child, html};
    Object.defineProperty(shared, '__proto__', {
      value: child,
      enumerable: true,
      writable: true,
      configurable: true,
    });
    Object.freeze(shared);
    const model = Object.freeze([shared, shared, unchanged]);
    const result = await serverAct(() =>
      ReactServerDOMServer.renderToResult(model),
    );
    const expanded = await ReactServerDOMClient.createFromResult(result);
    expect(expanded[0]).toBe(expanded[1]);
    expect(expanded[0].unchanged).toBe(expanded[2]);
    expect(expanded[2]).toEqual(unchanged);
    expect(expanded[0].text).toEqual(text);
    expect(Object.getPrototypeOf(expanded[0])).toBe(Object.prototype);
    expect(Object.keys(expanded[0])).toEqual(Object.keys(shared));
    expect(
      Object.getOwnPropertyDescriptor(expanded[0], '__proto__').value,
    ).toBe(expanded[0].text);
    expect(expanded[0].html.type).toBe('div');
    expect(expanded[0].html.key).toBe('greeting');
    expect(expanded[0].html.ref).toBe(null);
    expect(expanded[0].html.props.children).toBe(expanded[0].text);
    expect(html.props.children).toBe(child);
    if (__DEV__) {
      expect(expanded[0].html._owner).toBe(html._owner);
      expect(expanded[0].html._debugStack).toBe(html._debugStack);
      expect(expanded[0].html._debugTask).toBe(html._debugTask);
      expect(Object.keys(expanded[0].html)).toEqual(Object.keys(html));
      expect(Object.isFrozen(expanded[0].html)).toBe(true);
      expect(Object.isFrozen(expanded[0].html.props)).toBe(true);
    }
    expect(shared.text.type).toBe(Text);
    expect(calls).toBe(1);
  });

  it('aborts before starting work without calling Server Components', async () => {
    let calls = 0;
    function App() {
      calls++;
      return 'unreachable';
    }
    const reason = new Error('Cancelled');
    let result;
    await serverAct(() => {
      result = ReactServerDOMServer.renderToResult(<App />);
      result.abort(reason);
    });
    await expect(ReactServerDOMClient.createFromResult(result)).rejects.toBe(
      reason,
    );
    expect(calls).toBe(0);
  });

  // Adapted from the Hooks tests in react-client's ReactFlight-test.
  describe('Hooks', () => {
    function DivWithId({children}) {
      const id = ReactServer.useId();
      return <div prop={id}>{children}</div>;
    }

    it('should support useId', async () => {
      function App() {
        return (
          <>
            <DivWithId />
            <DivWithId />
          </>
        );
      }

      const result = await serverAct(() =>
        ReactServerDOMServer.renderToResult(<App />),
      );
      await act(async () => {
        ReactNoop.render(await ReactServerDOMClient.createFromResult(result));
      });
      expect(ReactNoop).toMatchRenderedOutput(
        <>
          <div prop="_S_1_" />
          <div prop="_S_2_" />
        </>,
      );
    });

    it('accepts an identifier prefix that prefixes generated ids', async () => {
      function App() {
        return (
          <>
            <DivWithId />
            <DivWithId />
          </>
        );
      }

      const result = await serverAct(() =>
        ReactServerDOMServer.renderToResult(<App />, {
          identifierPrefix: 'foo',
        }),
      );
      await act(async () => {
        ReactNoop.render(await ReactServerDOMClient.createFromResult(result));
      });
      expect(ReactNoop).toMatchRenderedOutput(
        <>
          <div prop="_fooS_1_" />
          <div prop="_fooS_2_" />
        </>,
      );
    });
  });

  // Adapted from react-reconciler's ReactCache-test.
  it('cached functions that throw should cache the error', async () => {
    const throws = ReactServer.cache(v => {
      throw new Error(v);
    });
    let x;
    let y;
    let z;
    function Test() {
      try {
        throws(1);
      } catch (e) {
        x = e;
      }
      try {
        throws(1);
      } catch (e) {
        y = e;
      }
      try {
        throws(2);
      } catch (e) {
        z = e;
      }

      return 'Blank';
    }

    await serverAct(() => ReactServerDOMServer.renderToResult(<Test />));
    expect(x).toBe(y);
    expect(z).not.toBe(x);
  });

  // Adapted from ReactCache-test.
  it('cacheSignal() aborts when the render finishes normally', async () => {
    let renderedCacheSignal = null;

    function Test() {
      renderedCacheSignal = ReactServer.cacheSignal();
      expect(renderedCacheSignal.aborted).toBe(false);
      return 'Hi';
    }

    const errors = [];
    const result = await serverAct(() =>
      ReactServerDOMServer.renderToResult(<Test />, {
        onError(x) {
          errors.push(x);
        },
      }),
    );

    expect(await ReactServerDOMClient.createFromResult(result)).toBe('Hi');
    expect(errors).toEqual([]);
    expect(renderedCacheSignal.aborted).toBe(true);
    expect(renderedCacheSignal.reason.message).toContain(
      'This render completed successfully.',
    );
  });

  // Adapted from react-client's ReactFlight-test.
  // @gate enableTaint
  it('errors when a tainted object is serialized', async () => {
    const user = {
      name: 'Seb',
      age: 'rather not say',
    };
    ReactServer.experimental_taintObjectReference(
      "Don't pass the raw user object to the client",
      user,
    );
    const errors = [];
    await serverAct(() =>
      ReactServerDOMServer.renderToResult(<span user={user} />, {
        onError(x) {
          errors.push(x.message);
        },
      }),
    );

    expect(errors).toEqual(["Don't pass the raw user object to the client"]);
  });

  // @gate enableTaint
  it('errors when a tainted element is returned from a Server Component', async () => {
    const element = <span>hello</span>;
    ReactServer.experimental_taintObjectReference(
      "Don't pass this element to the client",
      element,
    );
    function App() {
      return element;
    }
    const errors = [];
    await serverAct(() =>
      ReactServerDOMServer.renderToResult(<App />, {
        onError(x) {
          errors.push(x.message);
        },
      }),
    );

    expect(errors).toEqual(["Don't pass this element to the client"]);
  });
});
