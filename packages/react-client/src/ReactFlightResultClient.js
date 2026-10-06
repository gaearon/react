/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import type {Result} from 'shared/ReactFlightResult';
import type {ReactElement} from 'shared/ReactElementType';
import type {LazyComponent} from 'react/src/ReactLazy';
import type {
  ClientReferenceMetadata,
  ClientReference,
  ServerConsumerModuleMap,
  ModuleLoading,
} from './ReactFlightClientConfig';

import {getRoot, getErrorDigest} from 'shared/ReactFlightResult';
import {REACT_ELEMENT_TYPE, REACT_LAZY_TYPE} from 'shared/ReactSymbols';
import isArray from 'shared/isArray';
import hasOwnProperty from 'shared/hasOwnProperty';
import noop from 'shared/noop';
import {describeObjectForErrorMessage} from 'shared/ReactSerializationErrors';
import {
  resolveClientReference,
  prepareDestinationForModule,
  preloadModule,
  requireModule,
} from './ReactFlightClientConfig';

export type Response = {
  _result: Result<any>,
  _bundlerConfig: ServerConsumerModuleMap,
  _moduleLoading: ModuleLoading,
  _nonce: void | string,
  _resolveClientReferenceMetadata: Object => null | ClientReferenceMetadata,
  _models: Map<any, any>,
  _modules: Map<Object, SomeChunk<any>>,
  // DEV-only
  _completedElements: Array<ReactElement>,
};

export function createResponse(
  result: Result<any>,
  bundlerConfig: ServerConsumerModuleMap,
  moduleLoading: ModuleLoading,
  resolveClientReferenceMetadata: Object => null | ClientReferenceMetadata,
  nonce: void | string,
): Response {
  const response: Response = {
    _result: result,
    _bundlerConfig: bundlerConfig,
    _moduleLoading: moduleLoading,
    _nonce: nonce,
    _resolveClientReferenceMetadata: resolveClientReferenceMetadata,
    _models: new Map(),
    _modules: new Map(),
  } as any;
  if (__DEV__) {
    response._completedElements = [];
  }
  return response;
}

type PendingChunk<T> = {
  status: 'pending',
  value: null | Array<(T) => mixed>,
  reason: null | Array<(mixed) => mixed>,
  then(resolve: (T) => mixed, reject?: (mixed) => mixed): void,
};

type InitializedChunk<T> = {
  status: 'fulfilled',
  value: T,
  reason: null,
  then(resolve: (T) => mixed, reject?: (mixed) => mixed): void,
};

type ErroredChunk<T> = {
  status: 'rejected',
  value: null,
  reason: mixed,
  then(resolve: (T) => mixed, reject?: (mixed) => mixed): void,
};

type ResolvedModuleChunk<T> = {
  status: 'resolved_module',
  value: ClientReference<T>,
  reason: null,
  then(resolve: (T) => mixed, reject?: (mixed) => mixed): void,
};

type SomeChunk<T> =
  | PendingChunk<T>
  | InitializedChunk<T>
  | ErroredChunk<T>
  | ResolvedModuleChunk<T>;

const PENDING = 'pending';
const RESOLVED_MODULE = 'resolved_module';
const INITIALIZED = 'fulfilled';
const ERRORED = 'rejected';

function ReactPromise(this: any, status: any, value: any, reason: any) {
  this.status = status;
  this.value = value;
  this.reason = reason;
}
ReactPromise.prototype = Object.create(Promise.prototype) as any;

function reactPromiseThen<T>(
  this: SomeChunk<T>,
  resolve: T => mixed,
  reject?: mixed => mixed,
): void {
  const chunk = this;
  if (chunk.status === RESOLVED_MODULE) {
    initializeModuleChunk(chunk);
  }
  switch (chunk.status) {
    case INITIALIZED:
      if (typeof resolve === 'function') {
        resolve(chunk.value);
      }
      break;
    case PENDING:
      if (typeof resolve === 'function') {
        if (chunk.value === null) {
          chunk.value = [];
        }
        chunk.value.push(resolve);
      }
      if (typeof reject === 'function') {
        if (chunk.reason === null) {
          chunk.reason = [];
        }
        chunk.reason.push(reject);
      }
      break;
    default:
      if (typeof reject === 'function') {
        reject(chunk.reason);
      }
      break;
  }
}

Object.defineProperty(ReactPromise.prototype, 'then', {
  writable: true,
  enumerable: true,
  configurable: true,
  value: reactPromiseThen,
});

function createPendingChunk<T>(): SomeChunk<T> {
  // $FlowFixMe[invalid-constructor] Flow doesn't support functions as constructors
  return new ReactPromise(PENDING, null, null);
}

function createErrorChunk<T>(error: mixed): SomeChunk<T> {
  // $FlowFixMe[invalid-constructor] Flow doesn't support functions as constructors
  return new ReactPromise(ERRORED, null, error);
}

function wakeChunk<T>(listeners: Array<(T) => mixed>, value: T): void {
  for (let i = 0; i < listeners.length; i++) {
    listeners[i](value);
  }
}

function rejectChunk(listeners: Array<(mixed) => mixed>, error: mixed): void {
  for (let i = 0; i < listeners.length; i++) {
    listeners[i](error);
  }
}

function wakeChunkIfInitialized<T>(
  chunk: SomeChunk<T>,
  resolveListeners: null | Array<(T) => mixed>,
  rejectListeners: null | Array<(mixed) => mixed>,
): void {
  switch (chunk.status) {
    case INITIALIZED:
      if (resolveListeners !== null) {
        wakeChunk(resolveListeners, chunk.value);
      }
      break;
    case ERRORED:
      if (rejectListeners !== null) {
        rejectChunk(rejectListeners, chunk.reason);
      }
      break;
  }
}

function initializeChunk<T>(chunk: SomeChunk<T>, value: T): void {
  if (chunk.status !== PENDING) {
    return;
  }
  const resolveListeners = chunk.value;
  const rejectListeners = chunk.reason;
  const initializedChunk: InitializedChunk<T> = chunk as any;
  initializedChunk.status = INITIALIZED;
  initializedChunk.value = value;
  initializedChunk.reason = null;
  wakeChunkIfInitialized(chunk, resolveListeners, rejectListeners);
}

function triggerErrorOnChunk<T>(chunk: SomeChunk<T>, error: mixed): void {
  if (chunk.status !== PENDING) {
    return;
  }
  const listeners = chunk.reason;
  const erroredChunk: ErroredChunk<T> = chunk as any;
  erroredChunk.status = ERRORED;
  erroredChunk.reason = error;
  if (listeners !== null) {
    rejectChunk(listeners, error);
  }
}

function readChunk<T>(chunk: SomeChunk<T>): T {
  if (chunk.status === RESOLVED_MODULE) {
    initializeModuleChunk(chunk);
  }
  switch (chunk.status) {
    case INITIALIZED:
      return chunk.value;
    case PENDING:
      throw chunk;
    default:
      throw chunk.reason;
  }
}

function createLazyChunkWrapper<T>(
  chunk: SomeChunk<T>,
): LazyComponent<T, SomeChunk<T>> {
  return {$$typeof: REACT_LAZY_TYPE, _payload: chunk, _init: readChunk};
}

function initializeModuleChunk<T>(chunk: ResolvedModuleChunk<T>): void {
  try {
    const value = requireModule(chunk.value);
    const initializedChunk: InitializedChunk<T> = chunk as any;
    initializedChunk.status = INITIALIZED;
    initializedChunk.value = value;
    initializedChunk.reason = null;
  } catch (error) {
    const erroredChunk: ErroredChunk<T> = chunk as any;
    erroredChunk.status = ERRORED;
    erroredChunk.reason = error;
  }
}

function resolveModuleChunk<T>(
  chunk: SomeChunk<T>,
  clientReference: ClientReference<T>,
): void {
  if (chunk.status !== PENDING) {
    return;
  }
  const resolveListeners = chunk.value;
  const rejectListeners = chunk.reason;
  const resolvedChunk: ResolvedModuleChunk<T> = chunk as any;
  resolvedChunk.status = RESOLVED_MODULE;
  resolvedChunk.value = clientReference;
  resolvedChunk.reason = null;
  if (resolveListeners !== null) {
    initializeModuleChunk(resolvedChunk);
    wakeChunkIfInitialized(chunk, resolveListeners, rejectListeners);
  }
}

function resolveModule(
  response: Response,
  reference: Object,
): null | SomeChunk<any> {
  const existingChunk = response._modules.get(reference);
  if (existingChunk !== undefined) {
    return existingChunk;
  }
  let chunk;
  try {
    const clientReferenceMetadata =
      response._resolveClientReferenceMetadata(reference);
    if (clientReferenceMetadata === null) {
      return null;
    }
    chunk = createPendingChunk<any>();
    response._modules.set(reference, chunk);
    const clientReference = resolveClientReference<any>(
      response._bundlerConfig,
      clientReferenceMetadata,
    );
    prepareDestinationForModule(
      response._moduleLoading,
      response._nonce,
      clientReferenceMetadata,
    );
    const promise = preloadModule(clientReference);
    if (promise !== null) {
      promise.then(
        () => resolveModuleChunk(chunk, clientReference),
        error => triggerErrorOnChunk(chunk, error),
      );
    } else {
      resolveModuleChunk(chunk, clientReference);
    }
  } catch (error) {
    if (chunk === undefined) {
      chunk = createPendingChunk<any>();
      response._modules.set(reference, chunk);
    }
    triggerErrorOnChunk(chunk, error);
  }
  return chunk;
}

function createElement(
  response: Response,
  element: ReactElement,
  registerModel: boolean,
): ReactElement {
  let resolvedElement: ReactElement;
  if (__DEV__) {
    resolvedElement = {
      $$typeof: REACT_ELEMENT_TYPE,
      type: element.type,
      key: element.key,
      props: element.props,
      _owner: element._owner,
      _store: element._store,
    } as any;
    Object.defineProperties(resolvedElement, {
      ref: {value: null},
      _debugInfo: {value: element._debugInfo, writable: true},
      _debugStack: {value: element._debugStack, writable: true},
      _debugTask: {value: element._debugTask, writable: true},
    });
  } else {
    resolvedElement = {
      $$typeof: REACT_ELEMENT_TYPE,
      type: element.type,
      key: element.key,
      ref: null,
      props: element.props,
    } as any;
  }
  if (registerModel) {
    response._models.set(element, resolvedElement);
  }
  const type = element.type;
  const moduleChunk =
    type !== null && (typeof type === 'object' || typeof type === 'function')
      ? resolveModule(response, type as any)
      : null;
  if (moduleChunk !== null) {
    resolvedElement.type = createLazyChunkWrapper(moduleChunk);
  }
  resolvedElement.props = readModel(response, element.props);
  if (__DEV__) {
    response._completedElements.push(resolvedElement);
  }
  return resolvedElement;
}

function readElement(response: Response, element: ReactElement): any {
  const type = element.type;
  if (
    type !== null &&
    (typeof type === 'object' || typeof type === 'function')
  ) {
    resolveModule(response, type as any);
  }
  let promise;
  try {
    promise = preloadModel(response, element.props);
  } catch (error) {
    const lazy = createLazyChunkWrapper(createErrorChunk<any>(error));
    response._models.set(element, lazy);
    return lazy;
  }
  if (promise === null) {
    return createElement(response, element, true);
  }
  const chunk = createPendingChunk<any>();
  const lazy = createLazyChunkWrapper(chunk);
  response._models.set(element, lazy);
  promise.then(
    () => {
      try {
        initializeChunk(chunk, createElement(response, element, false));
      } catch (error) {
        triggerErrorOnChunk(chunk, error);
      } finally {
        freezeCompletedElements(response);
      }
    },
    error => triggerErrorOnChunk(chunk, error),
  );
  return lazy;
}

type UninitializedLazyPayload = {
  status: 'uninitialized',
  response: Response,
  lazy: LazyComponent<any, any>,
  chunk: null,
};

type InitializedLazyPayload = {
  status: 'initialized',
  response: null,
  lazy: null,
  chunk: SomeChunk<any>,
};

function readLazy(
  payload: UninitializedLazyPayload | InitializedLazyPayload,
): any {
  if (payload.status === 'initialized') {
    return readChunk(payload.chunk);
  }
  const response = payload.response;
  const lazy = payload.lazy;
  const chunk = createPendingChunk<any>();
  let model;
  try {
    model = lazy._init(lazy._payload);
  } catch (error) {
    if (
      lazy._payload.status !== 'rejected' &&
      error !== null &&
      typeof error === 'object' &&
      typeof (error as any).then === 'function'
    ) {
      throw error;
    }
    triggerErrorOnChunk(chunk, resolveError(response, lazy._payload, error));
  }
  const initializedPayload: InitializedLazyPayload = payload as any;
  initializedPayload.status = 'initialized';
  initializedPayload.response = null;
  initializedPayload.lazy = null;
  initializedPayload.chunk = chunk;
  if (chunk.status === PENDING) {
    try {
      const promise = preloadModel(response, model);
      if (promise === null) {
        initializeModelChunk(response, chunk, model);
      } else {
        promise.then(
          () => initializeModelChunk(response, chunk, model),
          error => triggerErrorOnChunk(chunk, error),
        );
      }
    } catch (error) {
      triggerErrorOnChunk(chunk, error);
    }
  }
  return readChunk(chunk);
}

function readModel(response: Response, value: any): any {
  if (
    value === null ||
    (typeof value !== 'object' && typeof value !== 'function')
  ) {
    return value;
  }

  const models = response._models;
  const existingModel = models.get(value);
  if (existingModel !== undefined || models.has(value)) {
    return existingModel;
  }

  const moduleChunk = resolveModule(response, value);
  if (moduleChunk !== null) {
    return readChunk(moduleChunk);
  }

  if (value.$$typeof === REACT_ELEMENT_TYPE) {
    return readElement(response, value);
  } else if (value.$$typeof === REACT_LAZY_TYPE) {
    const lazy: LazyComponent<any, any> = {
      $$typeof: REACT_LAZY_TYPE,
      _payload: {status: 'uninitialized', response, lazy: value, chunk: null},
      _init: readLazy,
    };
    if (__DEV__) {
      lazy._debugInfo = value._debugInfo;
      lazy._store = value._store;
    }
    models.set(value, lazy);
    return lazy;
  } else if (isArray(value)) {
    const copy: Array<any> = new Array(value.length);
    models.set(value, copy);
    for (let i = 0; i < value.length; i++) {
      if (hasOwnProperty.call(value, i)) {
        copy[i] = readModel(response, value[i]);
      }
    }
    return copy;
  } else {
    if (typeof value.then === 'function') {
      const promise = value.then(
        (model: any) => initializeModel(response, model),
        (error: mixed) => {
          throw resolveError(response, value, error);
        },
      );
      promise.catch(noop);
      models.set(value, promise);
      return promise;
    }
    const object: {[key: string]: any} = value;
    const copy: {[key: string]: any} = {};
    models.set(value, copy);
    const keys = Object.keys(object);
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      const child = readModel(response, object[key]);
      if (key === '__proto__') {
        Object.defineProperty(copy, key, {
          value: child,
          enumerable: true,
          writable: true,
          configurable: true,
        });
      } else {
        copy[key] = child;
      }
    }
    return copy;
  }
}

function preloadModel(response: Response, model: any): Promise<void> | null {
  const visited: Set<any> = new Set();
  const chunks: Set<SomeChunk<any>> = new Set();
  scanModel(response, model, visited, chunks);
  if (chunks.size === 0) {
    return null;
  }
  const promises = [];
  chunks.forEach(chunk => {
    promises.push(
      new Promise<void>((resolve, reject) => {
        chunk.then(() => resolve(), reject);
      }),
    );
  });
  return Promise.all(promises).then(noop);
}

function scanModel(
  response: Response,
  value: any,
  visited: Set<any>,
  chunks: Set<SomeChunk<any>>,
): void {
  if (
    value === null ||
    (typeof value !== 'object' && typeof value !== 'function') ||
    visited.has(value)
  ) {
    return;
  }
  visited.add(value);
  const chunk = resolveModule(response, value);
  if (chunk !== null) {
    if (chunk.status === RESOLVED_MODULE) {
      initializeModuleChunk(chunk);
    }
    if (chunk.status === ERRORED) {
      throw chunk.reason;
    }
    if (chunk.status === PENDING) {
      chunks.add(chunk);
    }
    return;
  }
  if (
    response._models.has(value) ||
    value.$$typeof === REACT_ELEMENT_TYPE ||
    value.$$typeof === REACT_LAZY_TYPE ||
    typeof value.then === 'function'
  ) {
    return;
  }
  if (isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      if (hasOwnProperty.call(value, i)) {
        scanModel(response, value[i], visited, chunks);
      }
    }
  } else {
    const object: {[key: string]: any} = value;
    const keys = Object.keys(object);
    for (let i = 0; i < keys.length; i++) {
      scanModel(response, object[keys[i]], visited, chunks);
    }
  }
}

function freezeCompletedElements(response: Response): void {
  if (__DEV__) {
    const elements = response._completedElements;
    for (let i = 0; i < elements.length; i++) {
      Object.freeze(elements[i].props);
      Object.freeze(elements[i]);
    }
    elements.length = 0;
  }
}

function completeModel(response: Response, model: any): any {
  try {
    return readModel(response, model);
  } finally {
    freezeCompletedElements(response);
  }
}

function initializeModel(response: Response, model: any): any {
  const promise = preloadModel(response, model);
  return promise === null
    ? completeModel(response, model)
    : promise.then(() => completeModel(response, model));
}

function initializeModelChunk<T>(
  response: Response,
  chunk: SomeChunk<T>,
  model: any,
): void {
  try {
    initializeChunk(chunk, completeModel(response, model));
  } catch (error) {
    triggerErrorOnChunk(chunk, error);
  }
}

function resolveError(
  response: Response,
  thenable: Object,
  error: mixed,
): mixed {
  const digest = getErrorDigest(response._result, thenable);
  if (digest === undefined) {
    return error;
  }
  let resolvedError;
  if (__DEV__) {
    let name = 'Error';
    let message;
    let descriptors = null;
    try {
      if (error instanceof Error) {
        name = error.name;
        // eslint-disable-next-line react-internal/safe-string-coercion
        message = String(error.message);
        descriptors = Object.getOwnPropertyDescriptors(error as any);
        delete descriptors.digest;
        delete descriptors.message;
        delete descriptors.name;
      } else if (typeof error === 'object' && error !== null) {
        message = describeObjectForErrorMessage(error);
      } else {
        // eslint-disable-next-line react-internal/safe-string-coercion
        message = String(error);
      }
    } catch (x) {
      message = 'An error occurred but serializing the error message failed.';
      descriptors = null;
    }
    // eslint-disable-next-line react-internal/prod-error-codes
    resolvedError = new Error(message);
    if (descriptors !== null) {
      Object.defineProperties(resolvedError, descriptors);
    }
    resolvedError.name = name;
  } else {
    resolvedError = new Error(
      'An error occurred in the Server Components render. The specific message is omitted in production' +
        ' builds to avoid leaking sensitive details. A digest property is included on this error instance which' +
        ' may provide additional details about the nature of the error.',
    );
    resolvedError.stack = 'Error: ' + resolvedError.message;
  }
  (resolvedError as any).digest = digest;
  return resolvedError;
}

export function readResult<T>(
  response: Response,
  result: Result<T>,
): Promise<T> {
  const root = getRoot(result);
  const promise = root.then(
    model => initializeModel(response, model),
    error => {
      throw resolveError(response, root, error);
    },
  );
  promise.catch(noop);
  return promise;
}
