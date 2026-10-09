/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import type {
  Input,
  InputThenableReader,
  InputSequenceReader,
  InputAsyncIterableReader,
} from './ReactFlightResultSerializationServer';
import type {Result, HintQueue, ErrorReference} from 'shared/ReactFlightResult';
import type {Thenable} from 'shared/ReactTypes';
import type {ResultStreamController} from 'shared/ReactFlightResultReadableStream';
import type {AsyncIterableController} from 'shared/ReactFlightResultAsyncIterable';
import {
  getResultModelStatus,
  subscribeToDebugInfo,
} from 'shared/ReactFlightResultModel';
import {
  getRoot,
  getErrorInfo,
  getValueReference,
  getModelInfo,
  getJSONWorkCredit,
  getCollectionEntries,
  getErrorReference,
  getReadableStream,
  getAsyncIterable,
  getIteratorEntries,
  getServerReference,
  getTemporaryReferenceSet,
  getHintQueue,
  waitForHints,
  subscribeToResult,
  subscribeToConsole,
  isHalted,
} from 'shared/ReactFlightResult';
import noop from 'shared/noop';

function subscribeToThenable(
  result: Result<any>,
  thenable: Thenable<any> | Promise<any>,
  reader: InputThenableReader,
): () => void {
  const status = getResultModelStatus(thenable);
  let unsubscribeDebugInfo = noop;
  if (__DEV__ && status !== null && reader.debug !== undefined) {
    unsubscribeDebugInfo = subscribeToDebugInfo(thenable as any, reader.debug);
  }
  if (status === 'fulfilled' || status === 'rejected') {
    if (isHalted(result, thenable)) {
      reader.halt();
    } else if (status === 'fulfilled') {
      reader.resolve((thenable as any).value);
    } else {
      reader.reject(
        (thenable as any).reason,
        getErrorReference(result, thenable),
      );
    }
    unsubscribeDebugInfo();
    return noop;
  }
  const subscription: {
    result: null | Result<any>,
    reader: null | InputThenableReader,
  } = {result, reader};
  let unsubscribe = noop;
  function detach(): void {
    subscription.result = null;
    subscription.reader = null;
    unsubscribe();
    if (__DEV__) {
      unsubscribeDebugInfo();
    }
  }
  unsubscribe = subscribeToResult(result, () => {
    const current = subscription.reader;
    const source = subscription.result;
    if (current !== null && source !== null && isHalted(source, thenable)) {
      detach();
      current.halt();
    }
  });
  if (subscription.reader !== null) {
    thenable.then(
      value => {
        const current = subscription.reader;
        if (current !== null) {
          detach();
          current.resolve(value);
        }
      },
      error => {
        const current = subscription.reader;
        const source = subscription.result;
        if (current !== null && source !== null) {
          const reference = getErrorReference(source, thenable as any);
          detach();
          if (isHalted(source, thenable)) {
            current.halt();
          } else {
            current.reject(error, reference);
          }
        }
      },
    );
  }
  return detach;
}

function subscribeToSequence(
  result: Result<any>,
  model: Object,
  source: ResultStreamController<any> | AsyncIterableController<any>,
  reader: InputSequenceReader,
): () => void {
  const entries: Array<Promise<any>> = [];
  let nextEntryIndex = 0;
  let reading = false;
  let draining = false;
  let active = true;
  let finish: null | (() => void) = null;
  let unsubscribeSource = noop;
  let unsubscribeEntry = noop;

  function detach(): void {
    active = false;
    entries.length = 0;
    unsubscribeSource();
    unsubscribeEntry();
  }

  function error(reason: mixed, reference: void | ErrorReference): void {
    if (active) {
      detach();
      reader.error(reason, reference);
    }
  }

  function halt(): void {
    if (active) {
      detach();
      reader.halt();
    }
  }

  function readNext(): void {
    if (!active || reading || draining) {
      return;
    }
    draining = true;
    try {
      while (active && !reading) {
        if (nextEntryIndex >= entries.length) {
          if (finish !== null) {
            finish();
          }
          break;
        }
        const entry = entries[nextEntryIndex++];
        if (nextEntryIndex === entries.length) {
          entries.length = 0;
          nextEntryIndex = 0;
        }
        reading = true;
        const unsubscribe = subscribeToThenable(result, entry, {
          resolve(value) {
            if (!active) {
              return;
            }
            reading = false;
            unsubscribeEntry = noop;
            reader.progress({value});
            readNext();
          },
          reject(reason, reference) {
            if (!active) {
              return;
            }
            reading = false;
            unsubscribeEntry = noop;
            reader.rejectEntry(reason, reference);
            readNext();
          },
          halt,
        });
        if (!active || !reading) {
          unsubscribe();
        } else {
          unsubscribeEntry = unsubscribe;
        }
      }
    } finally {
      draining = false;
    }
  }

  unsubscribeSource = source.subscribe({
    enqueue(entry) {
      if (active) {
        entries.push(entry);
        readNext();
      }
    },
    close() {
      finish = () => {
        detach();
        reader.progress({done: true, value: undefined});
      };
      readNext();
    },
    error(reason) {
      finish = () => error(reason, getErrorReference(result, model));
      readNext();
    },
    halt() {
      finish = halt;
      readNext();
    },
  });
  if (!active) {
    unsubscribeSource();
  }
  return detach;
}

function subscribeToAsyncIterable(
  result: Result<any>,
  model: Object,
  source: AsyncIterableController<any>,
  reader: InputAsyncIterableReader,
): () => void {
  return source.subscribe({
    enqueue: reader.enqueue,
    close: reader.close,
    error: reason => reader.error(reason, getErrorReference(result, model)),
    halt: reader.halt,
  });
}

export function createInput(result: Result<any>): Input {
  const input: Input = {
    root: getRoot(result),
    temporaryReferences: getTemporaryReferenceSet(result),
    getReadableStream(value) {
      const source = getReadableStream(result, value);
      return source === undefined
        ? undefined
        : {
            isByteStream: source.isByteStream,
            subscribe: reader =>
              subscribeToSequence(result, value, source, reader),
          };
    },
    getAsyncIterable(value) {
      const source = getAsyncIterable(result, value);
      return source === undefined
        ? undefined
        : {
            isIterator: source.isIterator,
            subscribe: reader =>
              subscribeToAsyncIterable(result, value, source, reader),
          };
    },
    getIteratorEntries: value => getIteratorEntries(result, value),
    getServerReference: value => getServerReference(result, value),
    getErrorInfo: value => getErrorInfo(result, value),
    getValueReference: value => getValueReference(result, value),
    getModelInfo: value => getModelInfo(result, value),
    getJSONWorkCredit: () => getJSONWorkCredit(result),
    getCollectionEntries: value => getCollectionEntries(result, value),
    subscribeToThenable: (thenable, reader) =>
      subscribeToThenable(result, thenable, reader),
    subscribe(reader) {
      const subscription: {
        queue: null | HintQueue,
        reader: null | typeof reader,
      } = {queue: getHintQueue(result), reader};
      let nextHintIndex = 0;
      let unsubscribe = noop;
      let unsubscribeConsole = noop;
      function detach(): void {
        subscription.queue = null;
        subscription.reader = null;
        unsubscribe();
        unsubscribeConsole();
      }
      function flushHints(): void {
        const queue = subscription.queue;
        const current = subscription.reader;
        if (queue === null || current === null) {
          return;
        }
        const hints = queue.completedHints;
        while (nextHintIndex < hints.length && subscription.reader !== null) {
          const hint = hints[nextHintIndex++];
          current.hint(hint.code, hint.model);
        }
        if (!queue.closed) {
          waitForHints(queue).then(flushHints);
        }
      }
      if (__DEV__ && reader.console !== undefined) {
        unsubscribeConsole = subscribeToConsole(result, reader.console);
      }
      unsubscribe = subscribeToResult(result, () => {
        const current = subscription.reader;
        if (current !== null) {
          flushHints();
          detach();
          current.complete();
        }
      });
      flushHints();
      return detach;
    },
  };
  if (__DEV__) {
    input.debugStartTime = (getRoot(result) as any)._debugStartTime;
  }
  return input;
}
