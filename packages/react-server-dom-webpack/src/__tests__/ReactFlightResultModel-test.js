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
let webpackModules;
let clientExports;
let webpackMap;

function readModel(model) {
  while (
    model !== null &&
    typeof model === 'object' &&
    model.$$typeof === Symbol.for('react.lazy')
  ) {
    model = model._init(model._payload);
  }
  return model;
}

describe('ReactFlightResult model', () => {
  beforeEach(() => {
    jest.resetModules();
    patchSetImmediate();
    jest.mock('react', () => require('react/react.react-server'));
    ReactServer = require('react');
    jest.mock('react-server-dom-webpack/server', () =>
      jest.requireActual('react-server-dom-webpack/server.node'),
    );
    const WebpackMock = require('./utils/WebpackMock');
    webpackModules = WebpackMock.webpackModules;
    clientExports = WebpackMock.clientExports;
    webpackMap = WebpackMock.webpackMap;
    ReactServerDOMServer = require('react-server-dom-webpack/server.node');
    serverAct = require('internal-test-utils').serverAct;

    jest.unmock('react-server-dom-webpack/server');
    jest.resetModules();
    __unmockReact();
    React = require('react');
    ReactNoop = require('react-noop-renderer');
    ReactServerDOMClient = require('react-server-dom-webpack/client.node');
    act = require('internal-test-utils').act;
  });

  it('resolves client references for a consumer and preserves the producer model', async () => {
    const ClientWrapper = ReactServerDOMServer.registerClientReference(
      function () {},
      'wrapper',
      'default',
    );
    const ClientModule =
      ReactServerDOMServer.createClientModuleProxy('wrapper');
    function Wrapper({children}) {
      return children;
    }
    function helper() {
      return 'hello';
    }
    const moduleExports = {Wrapper, helper, data: {text: 'world'}};
    webpackModules['ssr-wrapper'] = moduleExports;
    const clientManifest = {
      wrapper: {id: 'browser-wrapper', chunks: [], name: '*'},
    };
    const moduleMap = {
      'browser-wrapper': {
        default: {id: 'ssr-wrapper', chunks: [], name: 'Wrapper'},
        '*': {id: 'ssr-wrapper', chunks: [], name: '*'},
      },
    };
    const options = {
      clientManifest,
      serverConsumerManifest: {
        moduleMap,
        moduleLoading: null,
        serverModuleMap: null,
      },
    };
    function Text() {
      return <span>expanded</span>;
    }
    const html = (
      <ClientWrapper
        key="wrapper"
        component={ClientWrapper}
        helper={ClientModule.helper}
        value={ClientModule.data}
        module={ClientModule}>
        <Text />
      </ClientWrapper>
    );
    const result = await serverAct(() =>
      ReactServerDOMServer.renderToResult({html}),
    );
    const producer = await ReactServerDOMClient.createFromResult(result);
    const consumer = await ReactServerDOMClient.createFromResult(
      result,
      options,
    );
    expect(readModel(consumer.html.type)).toBe(Wrapper);
    expect(consumer.html.key).toBe('wrapper');
    expect(consumer.html.props.component).toBe(Wrapper);
    expect(consumer.html.props.helper()).toBe('hello');
    expect(consumer.html.props.value).toEqual({text: 'world'});
    expect(consumer.html.props.module).toBe(moduleExports);
    expect(consumer.html.props.children).toEqual(<span>expanded</span>);
    expect(producer.html.type).toBe(ClientWrapper);
    expect(producer.html.props.component).toBe(ClientWrapper);
    expect(producer.html.props.module).toBe(ClientModule);

    const consumer2 = await ReactServerDOMClient.createFromResult(
      result,
      options,
    );
    expect(consumer2).toEqual(consumer);
    const stream = await serverAct(() =>
      ReactServerDOMServer.renderToReadableStream(producer, clientManifest),
    );
    const decoded = await ReactServerDOMClient.createFromReadableStream(
      stream,
      {
        serverConsumerManifest: options.serverConsumerManifest,
      },
    );
    expect(readModel(decoded.html.type)).toBe(Wrapper);
    expect(decoded.html.props.helper()).toBe('hello');
  });

  it.each(['type', 'prop', 'root'])(
    'waits for a pending client module used as a %s',
    async position => {
      let resolveModule;
      const promise = new Promise(resolve => (resolveModule = resolve));
      function Component({text}) {
        return <span>{text ? text() : 'ready'}</span>;
      }
      const Client = clientExports(
        {Component, text: () => 'ready'},
        'client-module',
        'client-module.js',
        promise,
      );
      const model =
        position === 'root' ? (
          {text: Client.text}
        ) : (
          <React.Suspense fallback="loading">
            <Client.Component text={position === 'prop' ? Client.text : null} />
          </React.Suspense>
        );
      const result = await serverAct(() =>
        ReactServerDOMServer.renderToResult(model),
      );
      const response = ReactServerDOMClient.createFromResult(result, {
        clientManifest: webpackMap,
        serverConsumerManifest: {
          moduleMap: null,
          moduleLoading: null,
          serverModuleMap: null,
        },
      });
      let completed = false;
      response.then(() => {
        completed = true;
      });
      if (position === 'root') {
        await act(() => {});
        expect(completed).toBe(false);
      } else {
        await act(async () => ReactNoop.render(await response));
        expect(ReactNoop).toMatchRenderedOutput('loading');
      }
      await serverAct(() => resolveModule());
      if (position === 'root') {
        expect((await response).text()).toBe('ready');
      } else {
        await act(() => {});
        expect(ReactNoop).toMatchRenderedOutput(<span>ready</span>);
      }
    },
  );

  it('preserves a model without Server Components', async () => {
    const ClientWrapper = ReactServerDOMServer.registerClientReference(
      function ClientWrapper() {
        throw new Error('A client reference must not be called on the server.');
      },
      'wrapper',
      'default',
    );
    const cyclic = {element: null};
    const html = (
      <ClientWrapper data={cyclic}>
        <div>
          <span>hello</span>
        </div>
      </ClientWrapper>
    );
    cyclic.element = html;
    Object.freeze(cyclic);
    const model = Object.freeze({
      html,
      data: Object.freeze([NaN, -0, undefined, '$1', 42]),
    });
    const result = await serverAct(() =>
      ReactServerDOMServer.renderToResult(model),
    );
    expect(result.then).toBe(undefined);
    expect(result.pipe).toBe(undefined);
    const expanded = await ReactServerDOMClient.createFromResult(result);
    expect(expanded).toEqual(model);
    expect(expanded.html.props.data.element).toBe(expanded.html);
  });

  it('expands Server Components and preserves sharing', async () => {
    const ClientWrapper = ReactServerDOMServer.registerClientReference(
      function ClientWrapper() {
        throw new Error('A client reference must not be called on the server.');
      },
      'wrapper',
      'default',
    );
    const ClientModule = ReactServerDOMServer.createClientModuleProxy('module');
    const unchanged = Object.freeze({text: 'hello'});
    const text = <span>world</span>;
    let calls = 0;
    function Text() {
      calls++;
      return text;
    }
    const child = <Text />;
    const html = (
      <ClientWrapper
        key="greeting"
        data={unchanged}
        header={child}
        component={ClientWrapper}
        module={ClientModule}>
        <div>{child}</div>
      </ClientWrapper>
    );
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
    expect(expanded[0].html.type).toBe(ClientWrapper);
    expect(expanded[0].html.key).toBe('greeting');
    expect(expanded[0].html.ref).toBe(null);
    expect(expanded[0].html.props.data).toBe(expanded[2]);
    expect(expanded[0].html.props.header).toBe(expanded[0].text);
    expect(expanded[0].html.props.component).toBe(ClientWrapper);
    expect(expanded[0].html.props.module).toBe(ClientModule);
    expect(expanded[0].html.props.children.type).toBe('div');
    expect(expanded[0].html.props.children.props.children).toBe(
      expanded[0].text,
    );
    expect(html.props.children.props.children).toBe(child);
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

  it.each([0, 1])(
    'expands a Server Component at index %i in a mixed object and array cycle',
    async changedIndex => {
      const unchanged = {self: null};
      unchanged.self = unchanged;
      Object.freeze(unchanged);
      const text = <span>expanded</span>;
      let calls = 0;
      function Text() {
        calls++;
        return text;
      }
      const child = <Text />;
      const object = {array: null, unchanged};
      const array = new Array(4);
      array[changedIndex] = child;
      array[1 - changedIndex] = object;
      array[3] = array;
      object.array = array;
      Object.defineProperty(object, '__proto__', {
        value: array,
        enumerable: true,
        configurable: true,
        writable: true,
      });
      Object.freeze(object);
      Object.freeze(array);
      const model = Object.freeze([object, array, object, child, unchanged]);

      const result = await serverAct(() =>
        ReactServerDOMServer.renderToResult(model),
      );
      const expanded = await ReactServerDOMClient.createFromResult(result);
      const expandedObject = expanded[0];
      const expandedArray = expanded[1];
      expect(expandedObject).toBe(expanded[2]);
      expect(expandedObject.array).toBe(expandedArray);
      expect(expandedObject.unchanged).toBe(expanded[4]);
      expect(expanded[4].self).toBe(expanded[4]);
      expect(Object.getPrototypeOf(expandedObject)).toBe(Object.prototype);
      expect(
        Object.getOwnPropertyDescriptor(expandedObject, '__proto__').value,
      ).toBe(expandedArray);
      expect(expandedArray[changedIndex]).toBe(expanded[3]);
      expect(expandedArray[1 - changedIndex]).toBe(expandedObject);
      expect(expandedArray[3]).toBe(expandedArray);
      expect(expandedArray.length).toBe(4);
      expect(2 in expandedArray).toBe(false);
      expect(expanded[3]).toEqual(text);
      expect(object.array).toBe(array);
      expect(array[changedIndex]).toBe(child);
      expect(calls).toBe(1);
    },
  );

  it.each([false, true])(
    'preserves a cycle through client element props (props first: %s)',
    async propsFirst => {
      const ClientWrapper = ReactServerDOMServer.registerClientReference(
        function ClientWrapper() {
          throw new Error(
            'A client reference must not be called on the server.',
          );
        },
        'wrapper',
        'default',
      );
      const text = <span>expanded</span>;
      function Text() {
        return text;
      }
      const child = <Text />;
      const object = {element: null, child};
      const element = (
        <ClientWrapper key="cycle" data={object}>
          {child}
        </ClientWrapper>
      );
      object.element = element;
      Object.freeze(object);
      const values = Object.freeze([object, element, element.props]);
      const model = Object.freeze({
        first: propsFirst ? element.props : object,
        values,
      });

      const result = await serverAct(() =>
        ReactServerDOMServer.renderToResult(model),
      );
      const output = await ReactServerDOMClient.createFromResult(result);
      const expanded = output.values;
      expect(output.first).toBe(propsFirst ? expanded[2] : expanded[0]);
      expect(expanded[0].element).toBe(expanded[1]);
      expect(expanded[0].child).toEqual(text);
      expect(expanded[1].props).toBe(expanded[2]);
      expect(expanded[2].data).toBe(expanded[0]);
      expect(expanded[2].children).toBe(expanded[0].child);
      expect(expanded[1].type).toBe(ClientWrapper);
      expect(expanded[1].key).toBe('cycle');
      expect(object.element).toBe(element);
      expect(element.props.data).toBe(object);
      if (__DEV__) {
        expect(expanded[1]._owner).toBe(element._owner);
        expect(expanded[1]._debugStack).toBe(element._debugStack);
        expect(expanded[1]._debugTask).toBe(element._debugTask);
        expect(Object.isFrozen(expanded[1])).toBe(true);
        expect(Object.isFrozen(expanded[2])).toBe(true);
      }
    },
  );

  it.each([false, true])(
    'preserves keyed return slots and cycles (direct first: %s)',
    async directFirst => {
      const data = {element: null, component: null};
      const element = (
        <div key="outer" data={data}>
          <span key="inner">hello</span>
        </div>
      );
      let calls = 0;
      function Component() {
        calls++;
        return element;
      }
      const component = <Component />;
      data.element = element;
      data.component = component;
      Object.freeze(data);
      const model = directFirst
        ? [element, component, element, component]
        : [component, element, element, component];

      const result = await serverAct(() =>
        ReactServerDOMServer.renderToResult(model),
      );
      const expanded = await ReactServerDOMClient.createFromResult(result);

      const direct = expanded[directFirst ? 0 : 1];
      const returned = readModel(expanded[directFirst ? 1 : 0]);
      expect(Array.isArray(returned)).toBe(true);
      expect(returned.length).toBe(1);
      expect(returned[0].key).toBe('outer');
      expect(returned[0].props.children).toEqual(
        <span key="inner">hello</span>,
      );
      expect(returned[0].props.data).toBe(direct.props.data);
      expect(direct.props.data.element).toBe(direct);
      expect(readModel(direct.props.data.component)).toBe(returned);
      expect(readModel(expanded[3])).toBe(returned);
      expect(expanded[2]).toBe(direct);
      expect(calls).toBe(1);
    },
  );

  it('expands a Server Component returning a container that refers back to it', async () => {
    let calls = 0;
    const object = {child: null};
    function App() {
      calls++;
      return object;
    }
    const element = <App />;
    object.child = element;
    Object.freeze(object);

    const result = await serverAct(() =>
      ReactServerDOMServer.renderToResult(element),
    );
    const expanded = await ReactServerDOMClient.createFromResult(result);
    expect(expanded.child).toBe(expanded);
    expect(object.child).toBe(element);
    expect(calls).toBe(1);
  });

  it('resolves a chain of Server Components to the same cyclic container', async () => {
    let calls = 0;
    const object = {child: null};
    function A() {
      calls++;
      return b;
    }
    function B() {
      calls++;
      return object;
    }
    const a = <A />;
    const b = <B />;
    object.child = a;
    Object.freeze(object);
    const model = Object.freeze([a, b, object]);

    const result = await serverAct(() =>
      ReactServerDOMServer.renderToResult(model),
    );
    const expanded = await ReactServerDOMClient.createFromResult(result);
    expect(expanded[0]).toBe(expanded[1]);
    expect(expanded[0]).toBe(expanded[2]);
    expect(expanded[0].child).toBe(expanded[0]);
    expect(calls).toBe(2);
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

  it.each([undefined, null, 'text', NaN, -0])(
    'expands a shared Server Component returning %s once',
    async value => {
      let calls = 0;
      function App() {
        calls++;
        return value;
      }
      const element = <App />;
      const result = await serverAct(() =>
        ReactServerDOMServer.renderToResult([element, element]),
      );
      const expanded = await ReactServerDOMClient.createFromResult(result);
      expect(expanded[0]).toBe(value);
      expect(expanded[1]).toBe(value);
      expect(calls).toBe(1);
    },
  );

  it('reports a stack overflow for a cycle consisting only of Server Components', async () => {
    let calls = 0;
    function A() {
      calls++;
      return b;
    }
    function B() {
      calls++;
      return a;
    }
    const a = <A />;
    const b = <B />;
    const errors = [];
    const result = await serverAct(() =>
      ReactServerDOMServer.renderToResult(a, {
        onError(error) {
          errors.push(error);
        },
      }),
    );
    await expect(ReactServerDOMClient.createFromResult(result)).rejects.toThrow(
      RangeError,
    );
    expect(errors.length).toBe(1);
    expect(calls).toBe(2);
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
    function UserClient({user}) {
      return <span>{user.name}</span>;
    }
    const User = ReactServerDOMServer.registerClientReference(
      UserClient,
      'user',
      'default',
    );
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
      ReactServerDOMServer.renderToResult(<User user={user} />, {
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
