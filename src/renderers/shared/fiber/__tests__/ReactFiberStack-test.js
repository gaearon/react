/**
 * Copyright 2013-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @emails react-core
 */

'use strict';

let ReactFiberStack;

describe('ReactIncremental', () => {
  beforeEach(() => {
    jest.resetModules();

    ReactFiberStack = require('ReactFiberStack');
  });

  describe('createCursor', () => {
    it('should create a cursor with a default value', () => {
      const c = ReactFiberStack.createCursor(123);
      expect(c.current).toBe(123);
    });

    it('should create multiple independent cursors', () => {
      const c1 = ReactFiberStack.createCursor(123);
      const c2 = ReactFiberStack.createCursor('abc');
      expect(c1.current).toBe(123);
      expect(c2.current).toBe('abc');
    });
  });

  describe('getPrevious', () => {
    it('should return the default value (if set) when the stack is empty', () => {
      const f1 = {};
      const c = ReactFiberStack.createCursor(123);
      ReactFiberStack.push(c, 456, f1);
      expect(ReactFiberStack.getPrevious()).toBe(123);
    });

    it('should return the previous cursor value', () => {
      const f1 = {};
      const f2 = {};
      const c = ReactFiberStack.createCursor(null);
      ReactFiberStack.push(c, 123, f1);
      ReactFiberStack.push(c, 456, f2);
      expect(ReactFiberStack.getPrevious()).toBe(123);
    });

    it('should warn if previous is read while the stack is empty', () => {
      spyOn(console, 'error');
      ReactFiberStack.getPrevious();
      expect(console.error.calls.count()).toBe(1);
      expect(console.error.calls.argsFor(0)[0]).toBe('Warning: Unexpected read of previous.');
    });
  });

  describe('push / ReactFiberStack.pop', () => {
    it('should manage the stack for a single cursor', () => {
      const f1 = {};
      const f2 = {};
      const c = ReactFiberStack.createCursor(null);
      ReactFiberStack.push(c, 1, f1);
      expect(c.current).toBe(1);
      ReactFiberStack.push(c, 2, f2);
      expect(c.current).toBe(2);
      ReactFiberStack.pop(c, f2);
      expect(c.current).toBe(1);
      ReactFiberStack.pop(c, f1);
      expect(c.current).toBe(null);
    });

    it('should manage the stack for multiple cursors', () => {
      const f1 = {};
      const f2 = {};
      const c1 = ReactFiberStack.createCursor(null);
      const c2 = ReactFiberStack.createCursor(null);
      ReactFiberStack.push(c1, 'c1-a', f1);
      ReactFiberStack.push(c2, 'c2-a', f1);
      expect(c1.current).toBe('c1-a');
      expect(c2.current).toBe('c2-a');
      ReactFiberStack.push(c1, 'c1-b', f2);
      ReactFiberStack.push(c2, 'c2-b', f2);
      expect(c1.current).toBe('c1-b');
      expect(c2.current).toBe('c2-b');
      ReactFiberStack.pop(c2, f2);
      ReactFiberStack.pop(c1, f2);
      expect(c1.current).toBe('c1-a');
      expect(c2.current).toBe('c2-a');
      ReactFiberStack.pop(c2, f1);
      ReactFiberStack.pop(c1, f1);
      expect(c1.current).toBe(null);
      expect(c2.current).toBe(null);
    });

    it('should warn if ReactFiberStack.popping is done by the wrong Fiber as this implies a sequencing error', () => {
      spyOn(console, 'error');
      const f1 = {};
      const f2 = {};
      const c = ReactFiberStack.createCursor(null);
      ReactFiberStack.push(c, 'a', f1);
      ReactFiberStack.pop(c, f2);
      expect(console.error.calls.count()).toBe(1);
      expect(console.error.calls.argsFor(0)[0]).toBe('Warning: Unexpected Fiber popped.');
    });
  });

  describe('replace', () => {
    it('should replace the current cursor value without modifying the stack', () => {
      const f1 = {};
      const f2 = {};
      const c = ReactFiberStack.createCursor(null);
      ReactFiberStack.push(c, 1, f1);
      ReactFiberStack.push(c, 2, f2);
      expect(c.current).toBe(2);
      expect(ReactFiberStack.getPrevious()).toBe(1);
      ReactFiberStack.replace(c, 3, f2);
      expect(c.current).toBe(3);
      expect(ReactFiberStack.getPrevious()).toBe(1);
    });

    it('should warn if replace is done by the wrong Fiber as this implies a sequencing error', () => {
      spyOn(console, 'error');
      const f1 = {};
      const f2 = {};
      const c = ReactFiberStack.createCursor(null);
      ReactFiberStack.push(c, 1, f1);
      ReactFiberStack.replace(c, 2, f2);
      expect(console.error.calls.count()).toBe(1);
      expect(console.error.calls.argsFor(0)[0]).toBe('Warning: Unexpected Fiber replaced.');
    });
  });

  describe('reset', () => {
    it('should reset the stack to empty state', () => {
      const f1 = {};
      const c = ReactFiberStack.createCursor(null);
      ReactFiberStack.push(c, 123, f1);
      expect(ReactFiberStack.isEmpty()).toBe(false);
      ReactFiberStack.reset();
      expect(ReactFiberStack.isEmpty()).toBe(true);
    });
  });
});
