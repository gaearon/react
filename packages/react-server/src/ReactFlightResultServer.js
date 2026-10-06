/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import type {ReactClientValue} from './ReactFlightServer';
import type {Result} from 'shared/ReactFlightResult';
import type {ThenableState} from './ReactFlightThenable';
import type {
  ReactComponentInfo,
  ReactStackTrace,
  ReactCallSite,
  ReactKey,
  Thenable,
  PendingThenable,
  FulfilledThenable,
  RejectedThenable,
} from 'shared/ReactTypes';
import type {ReactElement} from 'shared/ReactElementType';
import type {LazyComponent} from 'react/src/ReactLazy';

export type {ReactClientValue} from './ReactFlightServer';

import {
  createResult,
  setErrorDigest,
  forwardErrorDigest,
} from 'shared/ReactFlightResult';
import {enableTaint} from 'shared/ReactFeatureFlags';
import {scheduleMicrotask} from './ReactServerStreamConfig';
import {
  isClientReference,
  supportsRequestStorage,
  requestStorage,
  parseStackTrace,
  supportsComponentStorage,
  componentStorage,
} from './ReactFlightServerConfig';
import {isOpaqueTemporaryReference} from './ReactFlightServerTemporaryReferences';
import {
  HooksDispatcher,
  prepareToUseHooksForRequest,
  prepareToUseHooksForComponent,
  getThenableStateAfterSuspending,
  resetHooksForRequest,
} from './ReactFlightResultHooks';
import {DefaultAsyncDispatcher} from './flight/ReactFlightResultAsyncDispatcher';
import {resolveOwner, setCurrentOwner} from './flight/ReactFlightCurrentOwner';
import {getOwnerStackByComponentInfoInDev} from 'shared/ReactComponentInfoStack';
import {resetOwnerStackLimit} from 'shared/ReactOwnerStackReset';
import {callComponentInDEV} from './ReactFlightCallUserSpace';
import {
  REACT_ELEMENT_TYPE,
  REACT_FRAGMENT_TYPE,
  REACT_LAZY_TYPE,
  REACT_SUSPENSE_TYPE,
} from 'shared/ReactSymbols';
import ReactSharedInternals from './ReactSharedInternalsServer';
import isArray from 'shared/isArray';
import getPrototypeOf from 'shared/getPrototypeOf';
import hasOwnProperty from 'shared/hasOwnProperty';
import noop from 'shared/noop';
import {SuspenseException, getSuspendedThenable} from './ReactFlightThenable';

function defaultFilterStackFrame(
  filename: string,
  functionName: string,
): boolean {
  return (
    filename !== '' &&
    !filename.startsWith('node:') &&
    !filename.includes('node_modules')
  );
}

function devirtualizeURL(url: string): string {
  if (url.startsWith('about://React/')) {
    // This callsite is a virtual fake callsite that came from another Flight client.
    // We need to reverse it back into the original location by stripping its prefix
    // and suffix. We don't need the environment name because it's available on the
    // parent object that will contain the stack.
    const envIdx = url.indexOf('/', 'about://React/'.length);
    const suffixIdx = url.lastIndexOf('?');
    if (envIdx > -1 && suffixIdx > -1) {
      return decodeURI(url.slice(envIdx + 1, suffixIdx));
    }
  }
  return url;
}

function filterStackTrace(
  request: Request,
  stack: ReactStackTrace,
): ReactStackTrace {
  // Keep the same owner stack filtering as Flight.
  const filterStackFrame = request.filterStackFrame;
  const filteredStack: ReactStackTrace = [];
  for (let i = 0; i < stack.length; i++) {
    const callsite = stack[i];
    const functionName = callsite[0];
    const url = devirtualizeURL(callsite[1]);
    const lineNumber = callsite[2];
    const columnNumber = callsite[3];
    if (filterStackFrame(url, functionName, lineNumber, columnNumber)) {
      // Preserve the source stack while devirtualizing its URL.
      const clone: ReactCallSite = callsite.slice(0) as any;
      clone[1] = url;
      filteredStack.push(clone);
    }
  }
  return filteredStack;
}

function getCurrentStackInDEV(): string {
  if (__DEV__) {
    const owner: null | ReactComponentInfo = resolveOwner();
    if (owner === null) {
      return '';
    }
    return getOwnerStackByComponentInfoInDev(owner);
  }
  return '';
}

const ObjectPrototype = Object.prototype;
const __PROTO__ = '__proto__';
type ReactClientObject = {+[key: string]: ReactClientValue};

// task status
const PENDING = 0;
const COMPLETED = 1;
const ABORTED = 3;
const ERRORED = 4;
const RENDERING = 5;

type Task = {
  status: 0 | 1 | 3 | 4 | 5,
  model: ReactClientValue,
  implicitSlot: boolean,
  promise: Promise<ReactClientValue>,
  resolve: (model: ReactClientValue) => void,
  reject: (error: mixed) => void,
  ping: () => void,
  thenableState: ThenableState | null,
  environmentName: string, // DEV-only
  debugOwner: null | ReactComponentInfo, // DEV-only
  debugStack: null | Error, // DEV-only
  debugTask: null | ConsoleTask, // DEV-only
};

interface Reference {}

const OPENING = 10;
const OPEN = 11;
const ABORTING = 12;
const CLOSED = 14;

export type Request = {
  result: Result<ReactClientValue>,
  renderedModels: WeakMap<Reference, ReactClientValue>,
  renderedImplicitModels: WeakMap<Reference, ReactClientValue>,
  renderingComponents: Map<Reference, ReactClientValue>,
  status: 10 | 11 | 12 | 14,
  fatalError: mixed,
  cache: Map<Function, mixed>,
  cacheController: AbortController,
  abortableTasks: Set<Task>,
  pingedTasks: Array<Task>,
  identifierPrefix: string,
  identifierCount: number,
  taintCleanupQueue: Array<string | bigint>,
  onError: (error: mixed) => ?string,
  // DEV-only
  completedElements: Array<ReactElement>,
  environmentName: () => string,
  filterStackFrame: (
    url: string,
    functionName: string,
    lineNumber: number,
    columnNumber: number,
  ) => boolean,
};

const {
  TaintRegistryObjects,
  TaintRegistryValues,
  TaintRegistryPendingRequests,
} = ReactSharedInternals;

function throwTaintViolation(message: string) {
  // eslint-disable-next-line react-internal/prod-error-codes
  throw new Error(message);
}

function cleanupTaintQueue(request: Request): void {
  const cleanupQueue = request.taintCleanupQueue;
  TaintRegistryPendingRequests.delete(cleanupQueue);
  for (let i = 0; i < cleanupQueue.length; i++) {
    const entryValue = cleanupQueue[i];
    const entry = TaintRegistryValues.get(entryValue);
    if (entry !== undefined) {
      if (entry.count === 1) {
        TaintRegistryValues.delete(entryValue);
      } else {
        entry.count--;
      }
    }
  }
  cleanupQueue.length = 0;
}

function defaultErrorHandler(error: mixed) {
  console['error'](error);
  // Don't transform to our wrapper
}

function RequestInstance(
  this: $FlowFixMe,
  model: ReactClientValue,
  onError: void | ((error: mixed) => ?string),
  identifierPrefix: void | string,
) {
  const abortSet: Set<Task> = new Set();
  const pingedTasks: Array<Task> = [];
  const cleanupQueue: Array<string | bigint> = [];
  if (enableTaint) {
    TaintRegistryPendingRequests.add(cleanupQueue);
  }
  this.status = OPENING;
  this.fatalError = null;
  this.renderedModels = new WeakMap();
  this.renderedImplicitModels = new WeakMap();
  this.renderingComponents = new Map();
  this.cache = new Map();
  this.cacheController = new AbortController();
  this.abortableTasks = abortSet;
  this.pingedTasks = pingedTasks;
  this.identifierPrefix = identifierPrefix || '';
  this.identifierCount = 1;
  this.taintCleanupQueue = cleanupQueue;
  this.onError = onError === undefined ? defaultErrorHandler : onError;
  if (__DEV__) {
    this.completedElements = [];
    this.environmentName = () => 'Server';
    this.filterStackFrame = defaultFilterStackFrame;
  }
  const rootTask = createTask(this, model, false, abortSet);
  this.result = createResult(rootTask.promise, reason => abort(this, reason));
  pingedTasks.push(rootTask);
}

export function createRequest(
  model: ReactClientValue,
  onError: void | ((error: mixed) => ?string),
  identifierPrefix: void | string,
): Request {
  if (__DEV__) {
    resetOwnerStackLimit();
  }

  // $FlowFixMe[invalid-constructor]: the shapes are exact here but Flow doesn't like constructors
  return new RequestInstance(model, onError, identifierPrefix);
}

export function getResult(request: Request): Result<ReactClientValue> {
  return request.result;
}

let currentRequest: null | Request = null;

export function resolveRequest(): null | Request {
  return currentRequest;
}

export function getCache(request: Request): Map<Function, mixed> {
  return request.cache;
}

function callWithDebugContextInDEV<A, T>(
  request: Request,
  task: Task,
  callback: A => T,
  arg: A,
): T {
  // Give callbacks the nearest component's owner stack, as in Flight.
  const componentDebugInfo: ReactComponentInfo = {
    name: '',
    env: task.environmentName,
    key: null,
    owner: task.debugOwner,
    stack:
      task.debugStack === null
        ? null
        : filterStackTrace(request, parseStackTrace(task.debugStack, 1)),
    debugStack: task.debugStack,
    debugTask: task.debugTask,
  };
  const debugTask = task.debugTask;
  const prevGetCurrentStack = ReactSharedInternals.getCurrentStack;
  ReactSharedInternals.getCurrentStack = getCurrentStackInDEV;
  // We don't need the async component storage context here so we only set the
  // synchronous tracking of owner.
  setCurrentOwner(componentDebugInfo);
  try {
    if (debugTask) {
      return debugTask.run(callback.bind(null, arg));
    }
    return callback(arg);
  } finally {
    setCurrentOwner(null);
    ReactSharedInternals.getCurrentStack = prevGetCurrentStack;
  }
}

function readThenable<T>(thenable: Thenable<T>): T {
  if (thenable.status === 'fulfilled') {
    return thenable.value;
  } else if (thenable.status === 'rejected') {
    throw thenable.reason;
  }
  throw thenable;
}

function createLazyWrapperAroundWakeable(
  thenable: Thenable<ReactClientValue>,
): ReactClientValue {
  switch (thenable.status) {
    case 'fulfilled':
      return thenable.value;
    case 'rejected':
      break;
    default: {
      if (typeof thenable.status === 'string') {
        break;
      }
      const pendingThenable: PendingThenable<ReactClientValue> =
        thenable as any;
      pendingThenable.status = 'pending';
      pendingThenable.then(
        value => {
          if (thenable.status === 'pending') {
            const fulfilledThenable: FulfilledThenable<ReactClientValue> =
              thenable as any;
            fulfilledThenable.status = 'fulfilled';
            fulfilledThenable.value = value;
          }
        },
        (error: mixed) => {
          if (thenable.status === 'pending') {
            const rejectedThenable: RejectedThenable<ReactClientValue> =
              thenable as any;
            rejectedThenable.status = 'rejected';
            rejectedThenable.reason = error;
          }
        },
      );
    }
  }
  const lazy: LazyComponent<ReactClientValue, Thenable<ReactClientValue>> = {
    $$typeof: REACT_LAZY_TYPE,
    _payload: thenable,
    _init: readThenable,
  };
  return lazy;
}

function renderFunctionComponent<Props: {[name: string]: mixed}>(
  request: Request,
  task: Task,
  key: ReactKey,
  Component: (p: Props, arg: void) => any,
  props: Props,
): ReactClientValue {
  const prevThenableState = task.thenableState;
  task.thenableState = null;

  let result: ReactClientValue;
  let componentDebugInfo: ReactComponentInfo;
  if (__DEV__) {
    if (prevThenableState !== null) {
      componentDebugInfo = (prevThenableState as any)._componentDebugInfo;
    } else {
      componentDebugInfo = {
        name: (Component as any).displayName || Component.name || '',
        env: (0, request.environmentName)(),
        key,
        owner: task.debugOwner,
        stack:
          task.debugStack === null
            ? null
            : filterStackTrace(request, parseStackTrace(task.debugStack, 1)),
        props,
        debugStack: task.debugStack,
        debugTask: task.debugTask,
      };
    }
    prepareToUseHooksForComponent(prevThenableState, componentDebugInfo);
    // $FlowFixMe[constant-condition]
    if (supportsComponentStorage) {
      if (task.debugTask) {
        result = task.debugTask.run(() =>
          componentStorage.run(
            componentDebugInfo,
            callComponentInDEV,
            Component,
            props,
            componentDebugInfo,
          ),
        );
      } else {
        result = componentStorage.run(
          componentDebugInfo,
          callComponentInDEV,
          Component,
          props,
          componentDebugInfo,
        );
      }
    } else {
      if (task.debugTask) {
        result = task.debugTask.run(() =>
          callComponentInDEV(Component, props, componentDebugInfo),
        );
      } else {
        result = callComponentInDEV(Component, props, componentDebugInfo);
      }
    }
  } else {
    componentDebugInfo = null as any;
    prepareToUseHooksForComponent(prevThenableState, null);
    result = Component(props, undefined);
  }

  if (request.status === ABORTING || request.status === CLOSED) {
    if (
      result != null &&
      typeof result === 'object' &&
      !isClientReference(result) &&
      typeof (result as any).then === 'function'
    ) {
      (result as any).then(noop, noop);
    }
    throw request.fatalError;
  }

  if (__DEV__) {
    task.debugOwner = componentDebugInfo;
    task.debugStack = null;
    task.debugTask = null;
    if (
      result != null &&
      typeof result === 'object' &&
      (result as any).$$typeof === REACT_ELEMENT_TYPE
    ) {
      (result as any)._store.validated = 1;
    }
  }

  return result;
}

function renderElement(
  request: Request,
  task: Task,
  value: ReactClientValue,
): ReactClientValue {
  const element: ReactElement = value as any;
  const type = element.type;
  const key = element.key;
  const props = element.props;
  const ref = props.ref;
  if (ref !== null && ref !== undefined) {
    throw new Error(
      'Refs cannot be used in Server Components, nor passed to Client Components.',
    );
  }
  if (
    typeof type === 'function' &&
    !isClientReference(type) &&
    !isOpaqueTemporaryReference(type)
  ) {
    if (key !== null) {
      throw unsupportedResultFeature('Keyed Server Components');
    }
    if (request.renderingComponents.has(element)) {
      const prevImplicitSlot = task.implicitSlot;
      task.implicitSlot = true;
      const resolvedModel = renderModelDestructive(
        request,
        task,
        request.renderingComponents.get(element),
      );
      task.implicitSlot = prevImplicitSlot;
      return resolvedModel;
    }
    const result = renderFunctionComponent(request, task, key, type, props);
    const prevImplicitSlot = task.implicitSlot;
    task.implicitSlot = true;
    if (
      result !== null &&
      typeof result === 'object' &&
      !isClientReference(result) &&
      typeof (result as any).then === 'function'
    ) {
      const thenable: Thenable<ReactClientValue> = result as any;
      if (__DEV__) {
        thenable.then(resolvedValue => {
          if (
            resolvedValue !== null &&
            typeof resolvedValue === 'object' &&
            (resolvedValue as any).$$typeof === REACT_ELEMENT_TYPE
          ) {
            (resolvedValue as any)._store.validated = 1;
          }
        }, noop);
      }
      const expandedThenable: Thenable<ReactClientValue> = renderModel(
        request,
        task,
        result,
      ) as any;
      const resolvedModel = createLazyWrapperAroundWakeable(expandedThenable);
      request.renderedModels.set(element, resolvedModel);
      task.implicitSlot = prevImplicitSlot;
      return resolvedModel;
    }
    request.renderingComponents.set(element, result);
    try {
      const resolvedModel = renderModel(request, task, result);
      request.renderedModels.set(element, resolvedModel);
      task.implicitSlot = prevImplicitSlot;
      return resolvedModel;
    } finally {
      request.renderingComponents.delete(element);
    }
  }

  if (
    typeof type === 'string' ||
    type === REACT_FRAGMENT_TYPE ||
    type === REACT_SUSPENSE_TYPE ||
    (type != null && isClientReference(type))
  ) {
    if (__DEV__ && task.implicitSlot) {
      element._store.validated = 1;
    }
    let resolvedElement: ReactElement;
    if (__DEV__) {
      resolvedElement = {
        $$typeof: REACT_ELEMENT_TYPE,
        type: element.type,
        key: element.key,
        props,
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
        props,
      } as any;
    }
    const renderedModels = getRenderedModels(
      request,
      element as any,
      task.implicitSlot,
    );
    const resolvedModel =
      task.implicitSlot && key !== null
        ? [resolvedElement as any]
        : (resolvedElement as any);
    renderedModels.set(element, resolvedModel);
    task.implicitSlot = false;
    resolvedElement.props = renderModel(request, task, props);
    if (__DEV__) {
      request.completedElements.push(resolvedElement);
    }
    return resolvedModel;
  }

  throw unsupportedResultFeature('This element type');
}

function createTask(
  request: Request,
  model: ReactClientValue,
  implicitSlot: boolean,
  abortSet: Set<Task>,
): Task {
  let resolve: (model: ReactClientValue) => void = noop;
  let reject: (error: mixed) => void = noop;
  const promise = new Promise<ReactClientValue>(
    (resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    },
  );
  const task: Task = {
    status: PENDING,
    model,
    implicitSlot,
    promise,
    resolve,
    reject,
    ping: () => pingTask(request, task),
    thenableState: null,
  } as Omit<
    Task,
    'environmentName' | 'debugOwner' | 'debugStack' | 'debugTask',
  > as any;
  if (__DEV__) {
    task.environmentName = request.environmentName();
    task.debugOwner = null;
    task.debugStack = null;
    task.debugTask = null;
  }
  abortSet.add(task);
  return task;
}

function pingTask(request: Request, task: Task): void {
  if (request.status >= ABORTING || task.status !== PENDING) {
    return;
  }
  const pingedTasks = request.pingedTasks;
  pingedTasks.push(task);
  if (pingedTasks.length === 1) {
    scheduleMicrotask(() => performWork(request));
  }
}

function renderThenable(
  request: Request,
  task: Task,
  value: ReactClientValue,
): ReactClientValue {
  const thenable: Thenable<ReactClientValue> = value as any;
  const newTask = createTask(
    request,
    value,
    task.implicitSlot,
    request.abortableTasks,
  );
  newTask.promise.then(noop, noop);
  getRenderedModels(request, value, task.implicitSlot).set(
    thenable,
    newTask.promise,
  );
  if (__DEV__) {
    newTask.environmentName = task.environmentName;
    newTask.debugOwner = task.debugOwner;
    newTask.debugStack = task.debugStack;
    newTask.debugTask = task.debugTask;
  }
  switch (thenable.status) {
    case 'fulfilled': {
      newTask.model = thenable.value;
      pingTask(request, newTask);
      break;
    }
    case 'rejected': {
      try {
        erroredTask(request, newTask, thenable.reason);
      } catch (error) {
        fatalError(request, error);
      }
      break;
    }
    default: {
      if (typeof thenable.status !== 'string') {
        const pendingThenable: PendingThenable<ReactClientValue> =
          thenable as any;
        pendingThenable.status = 'pending';
        pendingThenable.then(
          fulfilledValue => {
            if (thenable.status === 'pending') {
              const fulfilledThenable: FulfilledThenable<ReactClientValue> =
                thenable as any;
              fulfilledThenable.status = 'fulfilled';
              fulfilledThenable.value = fulfilledValue;
            }
          },
          (error: mixed) => {
            if (thenable.status === 'pending') {
              const rejectedThenable: RejectedThenable<ReactClientValue> =
                thenable as any;
              rejectedThenable.status = 'rejected';
              rejectedThenable.reason = error;
            }
          },
        );
      }
      thenable.then(
        fulfilledValue => {
          if (newTask.status === PENDING) {
            newTask.model = fulfilledValue;
            pingTask(request, newTask);
          }
        },
        reason => {
          if (newTask.status === PENDING) {
            try {
              erroredTask(request, newTask, reason);
            } catch (error) {
              fatalError(request, error);
            }
            scheduleMicrotask(() => performWork(request));
          }
        },
      );
    }
  }
  return newTask.promise;
}

function unsupportedResultFeature(feature: string): Error {
  return new Error(feature + ' is not yet implemented in Result.');
}

let modelRoot: null | ReactClientValue = false;

function getRenderedModels(
  request: Request,
  value: ReactClientValue,
  implicitSlot: boolean,
): WeakMap<Reference, ReactClientValue> {
  if (
    implicitSlot &&
    value !== null &&
    typeof value === 'object' &&
    (((value as any).$$typeof === REACT_ELEMENT_TYPE &&
      (value as any).key !== null) ||
      typeof (value as any).then === 'function')
  ) {
    // Flight does not reuse elements or promises across key contexts. Native
    // models need a separate memo for the implicit form to preserve cycles.
    return request.renderedImplicitModels;
  }
  return request.renderedModels;
}

function renderModel(
  request: Request,
  task: Task,
  value: ReactClientValue,
): ReactClientValue {
  const prevModel = task.model;
  const prevImplicitSlot = task.implicitSlot;
  const prevOwner = __DEV__ ? task.debugOwner : null;
  const prevStack = __DEV__ ? task.debugStack : null;
  const prevDebugTask = __DEV__ ? task.debugTask : null;
  try {
    return renderModelDestructive(request, task, value);
  } catch (thrownValue) {
    if (request.status >= ABORTING) {
      throw request.fatalError;
    }
    const error =
      thrownValue === SuspenseException ? getSuspendedThenable() : thrownValue;
    const model = task.model;
    if (
      model !== null &&
      typeof model === 'object' &&
      ((model as any).$$typeof === REACT_ELEMENT_TYPE ||
        (model as any).$$typeof === REACT_LAZY_TYPE)
    ) {
      const newTask = createTask(
        request,
        model,
        task.implicitSlot,
        request.abortableTasks,
      );
      const lazy = createLazyWrapperAroundWakeable(newTask.promise as any);
      if (__DEV__) {
        newTask.environmentName = task.environmentName;
        newTask.debugOwner = task.debugOwner;
        newTask.debugStack = task.debugStack;
        newTask.debugTask = task.debugTask;
      }
      if ((model as any).$$typeof === REACT_ELEMENT_TYPE) {
        getRenderedModels(request, model, task.implicitSlot).set(model, lazy);
      }
      if (
        value !== model &&
        value !== null &&
        typeof value === 'object' &&
        (value as any).$$typeof === REACT_ELEMENT_TYPE
      ) {
        getRenderedModels(request, value, prevImplicitSlot).set(value, lazy);
      }
      if (
        error != null &&
        typeof error === 'object' &&
        typeof (error as any).then === 'function'
      ) {
        const ping = newTask.ping;
        (error as any).then(ping, ping);
        newTask.thenableState = getThenableStateAfterSuspending();
      } else {
        erroredTask(request, newTask, error);
      }
      return lazy;
    }
    logRecoverableError(request, error, task);
    abort(request, error);
    throw error;
  } finally {
    task.model = prevModel;
    task.implicitSlot = prevImplicitSlot;
    if (__DEV__) {
      task.debugOwner = prevOwner;
      task.debugStack = prevStack;
      task.debugTask = prevDebugTask;
    }
  }
}

function renderModelDestructive(
  request: Request,
  task: Task,
  value: ReactClientValue,
): ReactClientValue {
  // As in Flight, this changes the task's current model. The input stays intact.
  task.model = value;

  if (
    value !== null &&
    (typeof value === 'object' || typeof value === 'function') &&
    isClientReference(value)
  ) {
    return value;
  }

  if (enableTaint) {
    // Check the source before copying it. A copy does not carry its taint mark.
    if (typeof value === 'string' || typeof value === 'bigint') {
      const tainted = TaintRegistryValues.get(value);
      if (tainted !== undefined) {
        throwTaintViolation(tainted.message);
      }
    } else if (
      value !== null &&
      (typeof value === 'object' || typeof value === 'function')
    ) {
      const tainted = TaintRegistryObjects.get(value);
      if (tainted !== undefined) {
        throwTaintViolation(tainted);
      }
    }
  }

  if (value === null || typeof value !== 'object') {
    if (typeof value === 'function') {
      throw unsupportedResultFeature('Function values');
    }
    // Strings, numbers, symbols, and other primitives stay native values.
    return value;
  }

  const renderedModels = getRenderedModels(request, value, task.implicitSlot);
  const existingModel = renderedModels.get(value);
  if (existingModel !== undefined || renderedModels.has(value)) {
    if (modelRoot === value) {
      if (
        existingModel !== task.promise &&
        !(
          existingModel !== null &&
          typeof existingModel === 'object' &&
          (existingModel as any).$$typeof === REACT_LAZY_TYPE &&
          (existingModel as any)._payload === task.promise
        )
      ) {
        return existingModel;
      }
      modelRoot = null;
    } else {
      return existingModel;
    }
  }

  const elementType = (value as any).$$typeof;
  if (elementType === REACT_ELEMENT_TYPE) {
    const element: ReactElement = value as any;
    if (__DEV__) {
      task.debugOwner = element._owner;
      task.debugStack = element._debugStack;
      task.debugTask = element._debugTask;
    }
    return renderElement(request, task, value);
  } else if (elementType === REACT_LAZY_TYPE) {
    task.thenableState = null;
    const lazy: LazyComponent<ReactClientValue, any> = value as any;
    const payload = lazy._payload;
    const init = lazy._init;
    const resolvedModel = init(payload);
    if (request.status === ABORTING || request.status === CLOSED) {
      throw request.fatalError;
    }
    return renderModelDestructive(request, task, resolvedModel);
  } else if (isArray(value)) {
    const array: Array<ReactClientValue> = value as any;
    const keys = Reflect.ownKeys(array);
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      if (typeof key === 'symbol') {
        throw unsupportedResultFeature('Symbol properties');
      }
      if (key === 'length') {
        continue;
      }
      const index = +key;
      if (
        index.toString() !== key ||
        !Number.isInteger(index) ||
        index < 0 ||
        index >= array.length
      ) {
        throw unsupportedResultFeature('Array properties');
      }
    }
    const copy: Array<ReactClientValue> = [];
    request.renderedModels.set(array, copy);
    task.implicitSlot = false;
    for (let i = 0; i < array.length; i++) {
      if (hasOwnProperty.call(array, i)) {
        copy[i] = renderModel(request, task, array[i]);
      }
    }
    copy.length = array.length;
    return copy;
  } else {
    const object: ReactClientObject = value as any;
    if (typeof (object as any).then === 'function') {
      return renderThenable(request, task, value);
    }
    if (getPrototypeOf(object) !== ObjectPrototype) {
      throw unsupportedResultFeature('This object type');
    }
    if (Object.getOwnPropertySymbols(object).length !== 0) {
      throw unsupportedResultFeature('Symbol properties');
    }
    const copy: {[key: string]: ReactClientValue} = {};
    request.renderedModels.set(object, copy);
    task.implicitSlot = false;
    const keys = Object.keys(object);
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      const child = renderModel(request, task, object[key]);
      if (key === __PROTO__) {
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

function logRecoverableError(
  request: Request,
  error: mixed,
  task: Task | null, // DEV-only
): string {
  const prevRequest = currentRequest;
  // We clear the request context so that console.logs inside the callback doesn't
  // get forwarded to the client.
  currentRequest = null;
  let errorDigest;
  try {
    const onError = request.onError;
    if (__DEV__ && task !== null) {
      // $FlowFixMe[constant-condition]
      if (supportsRequestStorage) {
        errorDigest = requestStorage.run(
          undefined,
          callWithDebugContextInDEV,
          request,
          task,
          onError,
          error,
        );
      } else {
        errorDigest = callWithDebugContextInDEV(request, task, onError, error);
      }
      // $FlowFixMe[constant-condition]
    } else if (supportsRequestStorage) {
      // Exit the request context while running callbacks.
      errorDigest = requestStorage.run(undefined, onError, error);
    } else {
      errorDigest = onError(error);
    }
  } finally {
    currentRequest = prevRequest;
  }
  if (errorDigest != null && typeof errorDigest !== 'string') {
    // eslint-disable-next-line react-internal/prod-error-codes
    throw new Error(
      `onError returned something with a type other than "string". onError should return a string and may return null or undefined but must not return anything else. It received something of type "${typeof errorDigest}" instead`,
    );
  }
  const digest = errorDigest || '';
  if (task !== null) {
    setErrorDigest(request.result, task.promise, digest);
  }
  return digest;
}

function fatalError(request: Request, error: mixed): void {
  abort(request, error);
}

function erroredTask(request: Request, task: Task, error: mixed): void {
  task.status = ERRORED;
  task.reject(error);
  const model = task.model;
  if (
    model !== null &&
    typeof model === 'object' &&
    (model as any).$$typeof === REACT_ELEMENT_TYPE
  ) {
    getRenderedModels(request, model, task.implicitSlot).set(
      model,
      createLazyWrapperAroundWakeable(task.promise as any),
    );
  }
  request.abortableTasks.delete(task);
  logRecoverableError(request, error, task);
}

function retryTask(request: Request, task: Task): void {
  if (task.status !== PENDING) {
    return;
  }
  task.status = RENDERING;
  try {
    modelRoot = task.model;
    let resolvedModel = renderModelDestructive(request, task, task.model);
    if (request.status === CLOSED || request.status === ABORTING) {
      return;
    }
    task.model = resolvedModel;
    task.status = COMPLETED;
    if (
      resolvedModel !== null &&
      typeof resolvedModel === 'object' &&
      (resolvedModel as any).$$typeof === REACT_LAZY_TYPE
    ) {
      const lazy: LazyComponent<
        ReactClientValue,
        Promise<ReactClientValue>,
      > = resolvedModel as any;
      resolvedModel = lazy._payload;
    }
    if (
      resolvedModel !== null &&
      typeof resolvedModel === 'object' &&
      typeof (resolvedModel as any).then === 'function'
    ) {
      forwardErrorDigest(request.result, task.promise, resolvedModel as any);
    }
    task.resolve(resolvedModel);
    request.abortableTasks.delete(task);
  } catch (thrownValue) {
    if (request.status >= ABORTING) {
      return;
    }
    const error =
      thrownValue === SuspenseException ? getSuspendedThenable() : thrownValue;
    const model = task.model;
    if (
      error != null &&
      typeof error === 'object' &&
      typeof (error as any).then === 'function' &&
      model !== null &&
      typeof model === 'object' &&
      ((model as any).$$typeof === REACT_ELEMENT_TYPE ||
        (model as any).$$typeof === REACT_LAZY_TYPE)
    ) {
      if (
        (model as any).$$typeof === REACT_ELEMENT_TYPE &&
        !getRenderedModels(request, model, task.implicitSlot).has(model)
      ) {
        getRenderedModels(request, model, task.implicitSlot).set(
          model,
          createLazyWrapperAroundWakeable(task.promise as any),
        );
      }
      task.status = PENDING;
      task.thenableState = getThenableStateAfterSuspending();
      const ping = task.ping;
      (error as any).then(ping, ping);
      return;
    }
    if (
      model !== null &&
      typeof model === 'object' &&
      ((model as any).$$typeof === REACT_ELEMENT_TYPE ||
        (model as any).$$typeof === REACT_LAZY_TYPE)
    ) {
      erroredTask(request, task, error);
    } else {
      logRecoverableError(request, error, task);
      abort(request, error);
    }
  }
}

function performWork(request: Request): void {
  if (request.status === CLOSED) {
    return;
  }
  const prevDispatcher = ReactSharedInternals.H;
  ReactSharedInternals.H = HooksDispatcher;
  const prevAsyncDispatcher = ReactSharedInternals.A;
  ReactSharedInternals.A = DefaultAsyncDispatcher;
  const prevGetCurrentStack = __DEV__
    ? ReactSharedInternals.getCurrentStack
    : null;
  if (__DEV__) {
    ReactSharedInternals.getCurrentStack = getCurrentStackInDEV;
  }
  const prevRequest = currentRequest;
  currentRequest = request;
  prepareToUseHooksForRequest(request);

  try {
    const pingedTasks = request.pingedTasks;
    request.pingedTasks = [];
    for (let i = 0; i < pingedTasks.length; i++) {
      const task = pingedTasks[i];
      retryTask(request, task);
    }
  } catch (error) {
    fatalError(request, error);
  } finally {
    modelRoot = null;
    if (__DEV__) {
      const elements = request.completedElements;
      for (let i = 0; i < elements.length; i++) {
        Object.freeze(elements[i].props);
        Object.freeze(elements[i]);
      }
      elements.length = 0;
    }
    if (request.status < ABORTING && request.abortableTasks.size === 0) {
      request.status = CLOSED;
      if (enableTaint) {
        cleanupTaintQueue(request);
      }
      request.cacheController.abort(
        new Error(
          'This render completed successfully. All cacheSignals are now aborted to allow clean up of any unused resources.',
        ),
      );
    }
    ReactSharedInternals.H = prevDispatcher;
    ReactSharedInternals.A = prevAsyncDispatcher;
    if (__DEV__) {
      ReactSharedInternals.getCurrentStack = prevGetCurrentStack;
    }
    resetHooksForRequest();
    currentRequest = prevRequest;
  }
}

export function startWork(request: Request): void {
  scheduleMicrotask(() => performWork(request));
}

export function abort(request: Request, reason: mixed): void {
  if (request.status > OPEN) {
    return;
  }
  request.status = ABORTING;
  const error =
    reason === undefined
      ? new Error('The render was aborted by the server without a reason.')
      : reason;
  request.fatalError = error;
  request.abortableTasks.forEach(task => {
    task.status = ABORTED;
    task.reject(error);
  });
  request.abortableTasks.clear();
  request.pingedTasks.length = 0;
  request.status = CLOSED;
  if (enableTaint) {
    cleanupTaintQueue(request);
  }
  request.cacheController.abort(error);
}
