/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @emails react-core
 */

'use strict';

import {patchSetImmediate} from '../../../../scripts/jest/patchSetImmediate';

// Polyfills for test environment
global.ReadableStream =
  require('web-streams-polyfill/ponyfill/es6').ReadableStream;
global.TextEncoder = require('util').TextEncoder;
global.TextDecoder = require('util').TextDecoder;

let act;
let serverAct;
let use;
let clientExports;
let webpackMap;
let React;
let ReactDOMClient;
let ReactServerDOMServer;
let ReactServerDOMResultClient;
let Suspense;
let ErrorBoundary;

// Copied from ReactFlightDOM-test with the Result entry points.
// Keep the models, views, and assertions aligned with the original tests.
describe('ReactFlightResult', () => {
  beforeEach(() => {
    // Load the Server Components scope with the react-server condition.
    jest.resetModules();
    document.head.innerHTML = '';
    patchSetImmediate();
    serverAct = require('internal-test-utils').serverAct;

    jest.mock('react', () => require('react/react.react-server'));
    jest.mock('react-server-dom-webpack/server', () =>
      jest.requireActual('react-server-dom-webpack/server.node'),
    );
    const WebpackMock = require('./utils/WebpackMock');
    clientExports = WebpackMock.clientExports;
    webpackMap = WebpackMock.webpackMap;
    ReactServerDOMServer = require('react-server-dom-webpack/server');

    // Load the SSR/Browser scope.
    jest.unmock('react-server-dom-webpack/server');
    __unmockReact();
    jest.resetModules();
    act = require('internal-test-utils').act;
    React = require('react');
    use = React.use;
    Suspense = React.Suspense;
    ReactDOMClient = require('react-dom/client');
    ReactServerDOMResultClient = require('react-server-dom-webpack/client.node');

    ErrorBoundary = class extends React.Component {
      state = {hasError: false, error: null};
      static getDerivedStateFromError(error) {
        return {
          hasError: true,
          error,
        };
      }
      render() {
        if (this.state.hasError) {
          return this.props.fallback(this.state.error);
        }
        return this.props.children;
      }
    };
  });

  it('should resolve HTML', async () => {
    function Text({children}) {
      return <span>{children}</span>;
    }
    function HTML() {
      return (
        <div>
          <Text>hello</Text>
          <Text>world</Text>
        </div>
      );
    }

    function App() {
      const model = {
        html: <HTML />,
      };
      return model;
    }

    const result = await serverAct(() =>
      ReactServerDOMServer.renderToResult(<App />),
    );
    const response = ReactServerDOMResultClient.createFromResult(result, {
      clientManifest: webpackMap,
      serverConsumerManifest: {
        moduleMap: null,
        moduleLoading: null,
        serverModuleMap: null,
      },
    });
    const model = await response;
    expect(model).toEqual({
      html: (
        <div>
          <span>hello</span>
          <span>world</span>
        </div>
      ),
    });
  });

  it('should resolve the root', async () => {
    // Model
    function Text({children}) {
      return <span>{children}</span>;
    }
    function HTML() {
      return (
        <div>
          <Text>hello</Text>
          <Text>world</Text>
        </div>
      );
    }
    function RootModel() {
      return {
        html: <HTML />,
      };
    }

    // View
    function Message({response}) {
      return <section>{use(response).html}</section>;
    }
    function App({response}) {
      return (
        <Suspense fallback={<h1>Loading...</h1>}>
          <Message response={response} />
        </Suspense>
      );
    }

    const result = await serverAct(() =>
      ReactServerDOMServer.renderToResult(<RootModel />),
    );
    const response = ReactServerDOMResultClient.createFromResult(result, {
      clientManifest: webpackMap,
      serverConsumerManifest: {
        moduleMap: null,
        moduleLoading: null,
        serverModuleMap: null,
      },
    });

    const container = document.createElement('div');
    const root = ReactDOMClient.createRoot(container);
    await act(() => {
      root.render(<App response={response} />);
    });
    expect(container.innerHTML).toBe(
      '<section><div><span>hello</span><span>world</span></div></section>',
    );
  });

  it('should not get confused by $', async () => {
    // Model
    function RootModel() {
      return {text: '$1'};
    }

    // View
    function Message({response}) {
      return <p>{use(response).text}</p>;
    }
    function App({response}) {
      return (
        <Suspense fallback={<h1>Loading...</h1>}>
          <Message response={response} />
        </Suspense>
      );
    }

    const result = await serverAct(() =>
      ReactServerDOMServer.renderToResult(<RootModel />),
    );
    const response = ReactServerDOMResultClient.createFromResult(result, {
      clientManifest: webpackMap,
      serverConsumerManifest: {
        moduleMap: null,
        moduleLoading: null,
        serverModuleMap: null,
      },
    });

    const container = document.createElement('div');
    const root = ReactDOMClient.createRoot(container);
    await act(() => {
      root.render(<App response={response} />);
    });
    expect(container.innerHTML).toBe('<p>$1</p>');
  });

  it('should not get confused by @', async () => {
    // Model
    function RootModel() {
      return {text: '@div'};
    }

    // View
    function Message({response}) {
      return <p>{use(response).text}</p>;
    }
    function App({response}) {
      return (
        <Suspense fallback={<h1>Loading...</h1>}>
          <Message response={response} />
        </Suspense>
      );
    }

    const result = await serverAct(() =>
      ReactServerDOMServer.renderToResult(<RootModel />),
    );
    const response = ReactServerDOMResultClient.createFromResult(result, {
      clientManifest: webpackMap,
      serverConsumerManifest: {
        moduleMap: null,
        moduleLoading: null,
        serverModuleMap: null,
      },
    });

    const container = document.createElement('div');
    const root = ReactDOMClient.createRoot(container);
    await act(() => {
      root.render(<App response={response} />);
    });
    expect(container.innerHTML).toBe('<p>@div</p>');
  });

  it.skip('should be able to esm compat test module references', async () => {
    const ESMCompatModule = {
      __esModule: true,
      default: function ({greeting}) {
        return greeting + ' World';
      },
      hi: 'Hello',
    };

    function Print({response}) {
      return <p>{use(response)}</p>;
    }

    function App({response}) {
      return (
        <Suspense fallback={<h1>Loading...</h1>}>
          <Print response={response} />
        </Suspense>
      );
    }

    function interopWebpack(obj) {
      // Basically what Webpack's ESM interop feature testing does.
      if (typeof obj === 'object' && obj.__esModule) {
        return obj;
      }
      return Object.assign({default: obj}, obj);
    }

    const {default: Component, hi} = interopWebpack(
      clientExports(ESMCompatModule),
    );

    const result = await serverAct(() =>
      ReactServerDOMServer.renderToResult(<Component greeting={hi} />),
    );
    const response = ReactServerDOMResultClient.createFromResult(result, {
      clientManifest: webpackMap,
      serverConsumerManifest: {
        moduleMap: null,
        moduleLoading: null,
        serverModuleMap: null,
      },
    });

    const container = document.createElement('div');
    const root = ReactDOMClient.createRoot(container);
    await act(() => {
      root.render(<App response={response} />);
    });
    expect(container.innerHTML).toBe('<p>Hello World</p>');
  });

  it.skip('should be able to render a named component export', async () => {
    const Module = {
      Component: function ({greeting}) {
        return greeting + ' World';
      },
    };

    function Print({response}) {
      return <p>{use(response)}</p>;
    }

    function App({response}) {
      return (
        <Suspense fallback={<h1>Loading...</h1>}>
          <Print response={response} />
        </Suspense>
      );
    }

    const {Component} = clientExports(Module);

    const result = await serverAct(() =>
      ReactServerDOMServer.renderToResult(<Component greeting={'Hello'} />),
    );
    const response = ReactServerDOMResultClient.createFromResult(result, {
      clientManifest: webpackMap,
      serverConsumerManifest: {
        moduleMap: null,
        moduleLoading: null,
        serverModuleMap: null,
      },
    });

    const container = document.createElement('div');
    const root = ReactDOMClient.createRoot(container);
    await act(() => {
      root.render(<App response={response} />);
    });
    expect(container.innerHTML).toBe('<p>Hello World</p>');
  });

  it.skip('should be able to render a module split named component export', async () => {
    const Module = {
      // This gets split into a separate module from the original one.
      split: function ({greeting}) {
        return greeting + ' World';
      },
    };

    function Print({response}) {
      return <p>{use(response)}</p>;
    }

    function App({response}) {
      return (
        <Suspense fallback={<h1>Loading...</h1>}>
          <Print response={response} />
        </Suspense>
      );
    }

    const {split: Component} = clientExports(Module);

    const result = await serverAct(() =>
      ReactServerDOMServer.renderToResult(<Component greeting={'Hello'} />),
    );
    const response = ReactServerDOMResultClient.createFromResult(result, {
      clientManifest: webpackMap,
      serverConsumerManifest: {
        moduleMap: null,
        moduleLoading: null,
        serverModuleMap: null,
      },
    });

    const container = document.createElement('div');
    const root = ReactDOMClient.createRoot(container);
    await act(() => {
      root.render(<App response={response} />);
    });
    expect(container.innerHTML).toBe('<p>Hello World</p>');
  });

  it.skip('should progressively reveal server components', async () => {
    let reportedErrors = [];

    // Client Components

    function MyErrorBoundary({children}) {
      return (
        <ErrorBoundary
          fallback={e => (
            <p>
              {__DEV__ ? e.message + ' + ' : null}
              {e.digest}
            </p>
          )}>
          {children}
        </ErrorBoundary>
      );
    }

    // Model
    function Text({children}) {
      return children;
    }

    function makeDelayedText() {
      let _resolve, _reject;
      let promise = new Promise((resolve, reject) => {
        _resolve = () => {
          promise = null;
          resolve();
        };
        _reject = e => {
          promise = null;
          reject(e);
        };
      });
      async function DelayedText({children}) {
        await promise;
        return <Text>{children}</Text>;
      }
      return [DelayedText, _resolve, _reject];
    }

    const [Friends, resolveFriends] = makeDelayedText();
    const [Name, resolveName] = makeDelayedText();
    const [Posts, resolvePosts] = makeDelayedText();
    const [Photos, resolvePhotos] = makeDelayedText();
    const [Games, , rejectGames] = makeDelayedText();

    // View
    function ProfileDetails({avatar}) {
      return (
        <div>
          <Name>:name:</Name>
          {avatar}
        </div>
      );
    }
    function ProfileSidebar({friends}) {
      return (
        <div>
          <Photos>:photos:</Photos>
          {friends}
        </div>
      );
    }
    function ProfilePosts({posts}) {
      return <div>{posts}</div>;
    }
    function ProfileGames({games}) {
      return <div>{games}</div>;
    }

    const MyErrorBoundaryClient = clientExports(MyErrorBoundary);

    function ProfileContent() {
      return (
        <>
          <ProfileDetails avatar={<Text>:avatar:</Text>} />
          <Suspense fallback={<p>(loading sidebar)</p>}>
            <ProfileSidebar friends={<Friends>:friends:</Friends>} />
          </Suspense>
          <Suspense fallback={<p>(loading posts)</p>}>
            <ProfilePosts posts={<Posts>:posts:</Posts>} />
          </Suspense>
          <MyErrorBoundaryClient>
            <Suspense fallback={<p>(loading games)</p>}>
              <ProfileGames games={<Games>:games:</Games>} />
            </Suspense>
          </MyErrorBoundaryClient>
        </>
      );
    }

    const model = {
      rootContent: <ProfileContent />,
    };

    function ProfilePage({response}) {
      return use(response).rootContent;
    }

    const result = await serverAct(() =>
      ReactServerDOMServer.renderToResult(model, {
        onError(x) {
          reportedErrors.push(x);
          return __DEV__ ? 'a dev digest' : `digest("${x.message}")`;
        },
      }),
    );
    const response = ReactServerDOMResultClient.createFromResult(result, {
      clientManifest: webpackMap,
      serverConsumerManifest: {
        moduleMap: null,
        moduleLoading: null,
        serverModuleMap: null,
      },
    });

    const container = document.createElement('div');
    const root = ReactDOMClient.createRoot(container);
    await act(() => {
      root.render(
        <Suspense fallback={<p>(loading)</p>}>
          <ProfilePage response={response} />
        </Suspense>,
      );
    });
    expect(container.innerHTML).toBe('<p>(loading)</p>');

    // This isn't enough to show anything.
    await serverAct(async () => {
      await act(() => {
        resolveFriends();
      });
    });
    expect(container.innerHTML).toBe('<p>(loading)</p>');

    // We can now show the details. Sidebar and posts are still loading.
    await serverAct(async () => {
      await act(() => {
        resolveName();
      });
    });
    // Advance time enough to trigger a nested fallback.
    await act(() => {
      jest.advanceTimersByTime(500);
    });
    expect(container.innerHTML).toBe(
      '<div>:name::avatar:</div>' +
        '<p>(loading sidebar)</p>' +
        '<p>(loading posts)</p>' +
        '<p>(loading games)</p>',
    );

    expect(reportedErrors).toEqual([]);

    const theError = new Error('Game over');
    // Let's *fail* loading games.
    await serverAct(async () => {
      await act(async () => {
        await rejectGames(theError);
        await 'the inner async function';
      });
    });
    const expectedGamesValue = __DEV__
      ? '<p>Game over + a dev digest</p>'
      : '<p>digest("Game over")</p>';
    expect(container.innerHTML).toBe(
      '<div>:name::avatar:</div>' +
        '<p>(loading sidebar)</p>' +
        '<p>(loading posts)</p>' +
        expectedGamesValue,
    );

    expect(reportedErrors).toEqual([theError]);
    reportedErrors = [];

    // We can now show the sidebar.
    await serverAct(async () => {
      await act(async () => {
        await resolvePhotos();
        await 'the inner async function';
      });
    });
    expect(container.innerHTML).toBe(
      '<div>:name::avatar:</div>' +
        '<div>:photos::friends:</div>' +
        '<p>(loading posts)</p>' +
        expectedGamesValue,
    );

    // Show everything.
    await serverAct(async () => {
      await act(async () => {
        await resolvePosts();
        await 'the inner async function';
      });
    });
    expect(container.innerHTML).toBe(
      '<div>:name::avatar:</div>' +
        '<div>:photos::friends:</div>' +
        '<div>:posts:</div>' +
        expectedGamesValue,
    );

    expect(reportedErrors).toEqual([]);
  });

  it.skip('should pass a Promise through props and be able use() it on the client', async () => {
    async function getData() {
      return 'async hello';
    }

    function Component({data}) {
      const text = use(data);
      return <p>{text}</p>;
    }

    const ClientComponent = clientExports(Component);

    function ServerComponent() {
      const data = getData(); // no await here
      return <ClientComponent data={data} />;
    }

    function Print({response}) {
      return use(response);
    }

    function App({response}) {
      return (
        <Suspense fallback={<h1>Loading...</h1>}>
          <Print response={response} />
        </Suspense>
      );
    }

    const result = await serverAct(() =>
      ReactServerDOMServer.renderToResult(<ServerComponent />),
    );
    const response = ReactServerDOMResultClient.createFromResult(result, {
      clientManifest: webpackMap,
      serverConsumerManifest: {
        moduleMap: null,
        moduleLoading: null,
        serverModuleMap: null,
      },
    });

    const container = document.createElement('div');
    const root = ReactDOMClient.createRoot(container);
    await act(() => {
      root.render(<App response={response} />);
    });
    expect(container.innerHTML).toBe('<p>async hello</p>');
  });
});
