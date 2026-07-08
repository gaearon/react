import {
  renderToPipeableStream,
  renderToReadableStream,
} from 'react-server-dom-webpack/server';
import App from './App';
import AppAsync from './AppAsync';
import AppFragmented from './AppFragmented';

export function renderRSCNode(clientManifest, Component, itemCount, options) {
  return renderToPipeableStream(
    <Component itemCount={itemCount} />,
    clientManifest,
    options
  );
}

export function renderRSCEdge(clientManifest, Component, itemCount) {
  return renderToReadableStream(
    <Component itemCount={itemCount} />,
    clientManifest
  );
}

export {App, AppAsync, AppFragmented};
