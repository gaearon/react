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

let clientExports;
let webpackMap;
let React;
let ReactDOMServer;
let ReactServer;
let ReactServerDOMServer;
let ReactServerDOMClient;
let Stream;
let use;
let serverAct;
let assertConsoleErrorDev;

describe('ReactFlightDOMPackedRows', () => {
  beforeEach(() => {
    jest.resetModules();

    patchSetImmediate();
    serverAct = require('internal-test-utils').serverAct;

    // Simulate the condition resolution
    jest.mock('react', () => require('react/react.react-server'));
    jest.mock('react-server-dom-webpack/server', () =>
      jest.requireActual('react-server-dom-webpack/server.node'),
    );
    ReactServer = require('react');
    ReactServerDOMServer = require('react-server-dom-webpack/server');

    const WebpackMock = require('./utils/WebpackMock');
    clientExports = WebpackMock.clientExports;
    webpackMap = WebpackMock.webpackMap;

    jest.resetModules();
    __unmockReact();
    jest.unmock('react-server-dom-webpack/server');
    jest.mock('react-server-dom-webpack/client', () =>
      jest.requireActual('react-server-dom-webpack/client.node'),
    );

    React = require('react');
    ReactDOMServer = require('react-dom/server.node');
    ReactServerDOMClient = require('react-server-dom-webpack/client');
    Stream = require('stream');
    use = React.use;

    assertConsoleErrorDev =
      require('internal-test-utils').assertConsoleErrorDev;
  });

  function readResult(stream) {
    return new Promise((resolve, reject) => {
      let buffer = '';
      const writable = new Stream.PassThrough();
      writable.setEncoding('utf8');
      writable.on('data', chunk => {
        buffer += chunk;
      });
      writable.on('error', error => {
        reject(error);
      });
      writable.on('end', () => {
        resolve(buffer);
      });
      stream.pipe(writable);
    });
  }

  // Renders a model and returns both the response root and the raw payload
  // text so tests can make assertions about the row structure.
  async function renderAndCapture(model, options) {
    const stream = await serverAct(() =>
      ReactServerDOMServer.renderToPipeableStream(model, webpackMap, options),
    );
    const readable = new Stream.PassThrough();
    const forText = new Stream.PassThrough();
    const trunk = new Stream.PassThrough();
    trunk.pipe(readable);
    trunk.pipe(forText);
    const payloadText = readResult(forText);
    const response = ReactServerDOMClient.createFromNodeStream(readable, {
      moduleMap: null,
      moduleLoading: null,
    });
    stream.pipe(trunk);
    return {response, payloadText: await payloadText};
  }

  function countModelRows(payloadText) {
    // Newline-terminated model rows: id, colon, then JSON. This excludes
    // DEV-only debug info rows (D/W/J) which exist per component regardless
    // of how models are packed. This app shape has no T/binary rows.
    return payloadText
      .split('\n')
      .filter(
        row =>
          /^[0-9a-f]+:["[{\d]/.test(row) ||
          /^[0-9a-f]+:(true|false|null|-)/.test(row),
      ).length;
  }

  async function renderToHTML(root) {
    const response = root;
    function Root() {
      return use(response);
    }
    const htmlStream = await serverAct(() =>
      ReactDOMServer.renderToPipeableStream(React.createElement(Root)),
    );
    return readResult(htmlStream);
  }

  // A flat page shape that crosses MAX_ROW_SIZE and previously deferred
  // every remaining sibling into its own row.
  function createFlatApp(paragraphCount) {
    function Paragraph({index}) {
      return ReactServer.createElement(
        'p',
        {className: 'text'},
        'This is paragraph number ',
        String(index),
        ' with enough copy to accumulate some serialized size along the way.',
      );
    }
    function App() {
      const children = [];
      for (let i = 0; i < paragraphCount; i++) {
        children.push(ReactServer.createElement(Paragraph, {key: i, index: i}));
      }
      return ReactServer.createElement('main', null, children);
    }
    return App;
  }

  it('packs deferred siblings into shared rows', async () => {
    const App = createFlatApp(200);
    const {response, payloadText} = await renderAndCapture(
      ReactServer.createElement(App),
    );
    const html = await renderToHTML(response);
    expect(html).toContain('This is paragraph number <!-- -->0');
    expect(html).toContain('This is paragraph number <!-- -->199');

    // Before packing this shape produced one model row per deferred
    // paragraph (150+ rows). Packed, the deferred tail fits in a handful.
    // In DEV every server component is outlined into its own row for debug
    // info, so the strict bound only holds in production.
    const rows = countModelRows(payloadText);
    if (!__DEV__) {
      expect(rows).toBeLessThan(30);
      // Sanity: packing actually happened; there are packed item references.
      expect(payloadText).toMatch(/\$L[0-9a-f]+:\d+/);
    } else {
      // In DEV server components outline themselves per row for debug info
      // before the size limit defers anything, so this shape doesn't pack.
      expect(rows).toBeLessThan(650);
    }
  });

  it('produces the same HTML as an equivalent small page', async () => {
    // The packed page must decode to the same model as one that never
    // crosses the deferral limit: render the same tree in two sizes and
    // compare the repeated unit.
    const BigApp = createFlatApp(200);
    const SmallApp = createFlatApp(3);
    const {response: bigResponse} = await renderAndCapture(
      ReactServer.createElement(BigApp),
    );
    const {response: smallResponse} = await renderAndCapture(
      ReactServer.createElement(SmallApp),
    );
    const bigHTML = await renderToHTML(bigResponse);
    const smallHTML = await renderToHTML(smallResponse);
    // Every paragraph in the small page appears identically in the big page.
    const smallParagraphs = smallHTML.match(/<p[^>]*>.*?<\/p>/g);
    expect(smallParagraphs.length).toBe(3);
    for (let i = 0; i < smallParagraphs.length; i++) {
      expect(bigHTML).toContain(smallParagraphs[i]);
    }
    const bigParagraphs = bigHTML.match(/<p[^>]*>.*?<\/p>/g);
    expect(bigParagraphs.length).toBe(200);
  });

  it('keeps children observably flat with correct keys', async () => {
    function Inspector({children}) {
      const flat = Array.isArray(children);
      const allElements =
        flat &&
        children.every(
          child =>
            child != null &&
            (typeof child === 'object' || typeof child === 'string'),
        );
      return React.createElement(
        'div',
        {
          'data-flat': String(flat),
          'data-all': String(allElements),
          'data-count': String(flat ? children.length : -1),
        },
        children,
      );
    }
    const InspectorRef = clientExports(Inspector);

    function Item({index}) {
      return ReactServer.createElement(
        'span',
        null,
        'Item body with some padding text to build up serialized size ',
        String(index),
      );
    }
    const children = [];
    for (let i = 0; i < 150; i++) {
      children.push(ReactServer.createElement(Item, {key: 'k' + i, index: i}));
    }
    const model = ReactServer.createElement(InspectorRef, null, children);

    const stream = await serverAct(() =>
      ReactServerDOMServer.renderToPipeableStream(model, webpackMap),
    );
    const readable = new Stream.PassThrough();
    const response = ReactServerDOMClient.createFromNodeStream(readable, {
      moduleMap: null,
      moduleLoading: null,
    });
    stream.pipe(readable);
    const html = await renderToHTML(response);
    // The client component observed a flat array of the full length.
    expect(html).toContain('data-flat="true"');
    expect(html).toContain('data-count="150"');
    expect(html).toContain(
      'Item body with some padding text to build up serialized size <!-- -->149',
    );
  });

  it('recovers per item when a packed item suspends', async () => {
    let resolveData;
    const dataPromise = new Promise(resolve => (resolveData = resolve));
    function SyncItem({index}) {
      return ReactServer.createElement(
        'i',
        null,
        'sync item with plenty of text to push the row over the limit ',
        String(index),
      );
    }
    async function AsyncItem() {
      const text = await dataPromise;
      return ReactServer.createElement('b', null, text);
    }
    const children = [];
    for (let i = 0; i < 100; i++) {
      children.push(ReactServer.createElement(SyncItem, {key: i, index: i}));
    }
    // An async item deep in the deferred tail.
    children.push(ReactServer.createElement(AsyncItem, {key: 'async'}));
    const model = ReactServer.createElement('section', null, children);

    // Wire manually: the payload doesn't end until the async item resolves.
    const stream = await serverAct(() =>
      ReactServerDOMServer.renderToPipeableStream(model, webpackMap),
    );
    const readable = new Stream.PassThrough();
    const response = ReactServerDOMClient.createFromNodeStream(readable, {
      moduleMap: null,
      moduleLoading: null,
    });
    stream.pipe(readable);
    const htmlPromise = renderToHTML(response);
    await serverAct(() => resolveData('finally here'));
    const html = await htmlPromise;
    expect(html).toContain(
      'sync item with plenty of text to push the row over the limit <!-- -->99',
    );
    expect(html).toContain('<b>finally here</b>');
  });

  it('errors every packed item when the render is aborted', async () => {
    const never = new Promise(() => {});
    function SyncItem({index}) {
      return ReactServer.createElement(
        'i',
        null,
        'item text that adds serialized weight for deferral purposes ',
        String(index),
      );
    }
    async function Hanging() {
      await never;
      return null;
    }
    const children = [];
    for (let i = 0; i < 100; i++) {
      children.push(ReactServer.createElement(SyncItem, {key: i, index: i}));
    }
    children.push(ReactServer.createElement(Hanging, {key: 'hang'}));

    const errors = [];
    const stream = await serverAct(() =>
      ReactServerDOMServer.renderToPipeableStream(
        ReactServer.createElement('section', null, children),
        webpackMap,
        {
          onError(error) {
            errors.push(error.message);
            return 'digest';
          },
        },
      ),
    );
    const readable = new Stream.PassThrough();
    const response = ReactServerDOMClient.createFromNodeStream(readable, {
      moduleMap: null,
      moduleLoading: null,
    });
    stream.pipe(readable);
    await serverAct(() => stream.abort(new Error('goodbye')));
    let error = null;
    try {
      await renderToHTML(response);
    } catch (x) {
      error = x;
    }
    expect(error).not.toBe(null);
    expect(error.digest).toBe('digest');
    expect(errors).toContain('goodbye');
    assertConsoleErrorDev(['[Server] Error: goodbye\n    in <stack>']);
  });

  it('dedupes shared objects referenced from packed items', async () => {
    const shared = {shared: 'value'};
    function Item({index}) {
      return ReactServer.createElement(
        'span',
        {'data-index': index},
        'padding text to accumulate row size for deferral to happen soon ',
        String(index),
      );
    }
    const children = [];
    for (let i = 0; i < 100; i++) {
      children.push(ReactServer.createElement(Item, {key: i, index: i}));
    }
    const model = {
      tree: ReactServer.createElement('section', null, children),
      a: shared,
      b: shared,
    };
    const {response} = await renderAndCapture(model);
    const result = await response;
    expect(result.a).toBe(result.b);
  });
});
