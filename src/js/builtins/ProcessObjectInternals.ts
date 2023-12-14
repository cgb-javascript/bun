/*
 * Copyright Joyent, Inc. and other Node contributors.
 * Copyright 2023 Codeblog Corp. All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions
 * are met:
 * 1. Redistributions of source code must retain the above copyright
 *    notice, this list of conditions and the following disclaimer.
 * 2. Redistributions in binary form must reproduce the above copyright
 *    notice, this list of conditions and the following disclaimer in the
 *    documentation and/or other materials provided with the distribution.
 *
 * THIS SOFTWARE IS PROVIDED BY APPLE INC. ``AS IS'' AND ANY
 * EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
 * IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR
 * PURPOSE ARE DISCLAIMED.  IN NO EVENT SHALL APPLE INC. OR
 * CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL,
 * EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO,
 * PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR
 * PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY
 * OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
 * (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */

export function getStdioWriteStream(fd) {
  const tty = require("node:tty");

  const stream = tty.WriteStream(fd);

  process.on("SIGWINCH", () => {
    stream._refreshSize();
  });

  if (fd === 1) {
    stream.destroySoon = stream.destroy;
    stream._destroy = function (err, cb) {
      cb(err);
      this._undestroy();

      if (!this._writableState.emitClose) {
        process.nextTick(() => {
          this.emit("close");
        });
      }
    };
  } else if (fd === 2) {
    stream.destroySoon = stream.destroy;
    stream._destroy = function (err, cb) {
      cb(err);
      this._undestroy();

      if (!this._writableState.emitClose) {
        process.nextTick(() => {
          this.emit("close");
        });
      }
    };
  }

  stream._type = "tty";
  stream._isStdio = true;
  stream.fd = fd;

  return stream;
}

export function getStdinStream(fd) {
  // Ideally we could use this:
  // return require("node:stream")[Symbol.for("::bunternal::")]._ReadableFromWeb(Bun.stdin.stream());
  // but we need to extend TTY/FS ReadStream
  const native = Bun.stdin.stream();

  var reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  var readerRef;

  var shouldUnref = false;

  function ref() {
    $debug("ref();", reader ? "already has reader" : "getting reader");
    reader ??= native.getReader();
    // TODO: remove this. likely we are dereferencing the stream
    // when there is still more data to be read.
    readerRef ??= setInterval(() => {}, 1 << 30);
    shouldUnref = false;
  }

  function unref() {
    $debug("unref();");
    if (readerRef) {
      clearInterval(readerRef);
      readerRef = undefined;
      $debug("cleared timeout");
    }
    if (reader) {
      try {
        reader.releaseLock();
        reader = undefined;
        $debug("released reader");
      } catch (e: any) {
        $debug("reader lock cannot be released, waiting");
        $assert(e.message === "There are still pending read requests, cannot release the lock");

        // Releasing the lock is not possible as there are active reads
        // we will instead pretend we are unref'd, and release the lock once the reads are finished.
        shouldUnref = true;

        // unref the native part of the stream
        try {
          $getByIdDirectPrivate(
            $getByIdDirectPrivate(native, "readableStreamController"),
            "underlyingByteSource",
          ).$resume(false);
        } catch (e) {
          if (IS_BUN_DEVELOPMENT) {
            // we assume this isn't possible, but because we aren't sure
            // we will ignore if error during release, but make a big deal in debug
            console.error(e);
            $assert(!"reachable");
          }
        }
      }
    }
  }

  const tty = require("node:tty");

  const ReadStream = tty.isatty(fd) ? tty.ReadStream : require("node:fs").ReadStream;
  const stream = new ReadStream(fd);

  const originalOn = stream.on;

  let stream_destroyed = false;
  stream.on = function (event, listener) {
    // Streams don't generally required to present any data when only
    // `readable` events are present, i.e. `readableFlowing === false`
    //
    // However, Node.js has a this quirk whereby `process.stdin.read()`
    // blocks under TTY mode, thus looping `.read()` in this particular
    // case would not result in truncation.
    //
    // Therefore the following hack is only specific to `process.stdin`
    // and does not apply to the underlying Stream implementation.
    if (event === "readable") {
      ref();
    }
    return originalOn.$call(this, event, listener);
  };

  stream.fd = fd;

  const originalPause = stream.pause;
  stream.pause = function () {
    $debug("pause();");
    let r = originalPause.$call(this);
    unref();
    return r;
  };

  const originalResume = stream.resume;
  stream.resume = function () {
    $debug("resume();");
    ref();
    return originalResume.$call(this);
  };

  async function internalRead(stream) {
    $debug("internalRead();");
    try {
      var done: boolean, value: Uint8Array[];
      $assert(reader);
      const pendingRead = reader.readMany();

      if ($isPromise(pendingRead)) {
        ({ done, value } = await pendingRead);
      } else {
        $debug("readMany() did not return a promise");
        ({ done, value } = pendingRead);
      }

      if (!done) {
        stream.push(value[0]);

        // shouldn't actually happen, but just in case
        const length = value.length;
        for (let i = 1; i < length; i++) {
          stream.push(value[i]);
        }

        if (shouldUnref) unref();
      } else {
        stream.emit("end");
        if (!stream_destroyed) {
          stream_destroyed = true;
          stream.destroy();
          unref();
        }
      }
    } catch (err) {
      stream.destroy(err);
    }
  }

  stream._read = function (size) {
    $debug("_read();", reader);
    if (!reader) {
      // TODO: this is wrong
      this.push(null);
    } else if (!shouldUnref) {
      internalRead(this);
    }
  };

  stream.on("resume", () => {
    $debug('on("resume");');
    ref();
    stream._undestroy();
  });

  stream._readableState.reading = false;

  stream.on("pause", () => {
    process.nextTick(() => {
      if (!stream.readableFlowing) {
        stream._readableState.reading = false;
      }
    });
  });

  stream.on("close", () => {
    if (!stream_destroyed) {
      stream_destroyed = true;
      process.nextTick(() => {
        stream.destroy();
        unref();
      });
    }
  });

  return stream;
}

export function initializeNextTickQueue(process, nextTickQueue, drainMicrotasksFn, reportUncaughtExceptionFn) {
  var queue;
  var process;
  var nextTickQueue = nextTickQueue;
  var drainMicrotasks = drainMicrotasksFn;
  var reportUncaughtException = reportUncaughtExceptionFn;

  function validateFunction(cb) {
    if (typeof cb !== "function") {
      const err = new TypeError(`The "callback" argument must be of type "function". Received type ${typeof cb}`);
      err.code = "ERR_INVALID_ARG_TYPE";
      throw err;
    }
  }

  var setup;
  setup = () => {
    queue = (function createQueue() {
      // Currently optimal queue size, tested on V8 6.0 - 6.6. Must be power of two.
      const kSize = 2048;
      const kMask = kSize - 1;

      // The FixedQueue is implemented as a singly-linked list of fixed-size
      // circular buffers. It looks something like this:
      //
      //  head                                                       tail
      //    |                                                          |
      //    v                                                          v
      // +-----------+ <-----\       +-----------+ <------\         +-----------+
      // |  [null]   |        \----- |   next    |         \------- |   next    |
      // +-----------+               +-----------+                  +-----------+
      // |   item    | <-- bottom    |   item    | <-- bottom       |  [empty]  |
      // |   item    |               |   item    |                  |  [empty]  |
      // |   item    |               |   item    |                  |  [empty]  |
      // |   item    |               |   item    |                  |  [empty]  |
      // |   item    |               |   item    |       bottom --> |   item    |
      // |   item    |               |   item    |                  |   item    |
      // |    ...    |               |    ...    |                  |    ...    |
      // |   item    |               |   item    |                  |   item    |
      // |   item    |               |   item    |                  |   item    |
      // |  [empty]  | <-- top       |   item    |                  |   item    |
      // |  [empty]  |               |   item    |                  |   item    |
      // |  [empty]  |               |  [empty]  | <-- top  top --> |  [empty]  |
      // +-----------+               +-----------+                  +-----------+
      //
      // Or, if there is only one circular buffer, it looks something
      // like either of these:
      //
      //  head   tail                                 head   tail
      //    |     |                                     |     |
      //    v     v                                     v     v
      // +-----------+                               +-----------+
      // |  [null]   |                               |  [null]   |
      // +-----------+                               +-----------+
      // |  [empty]  |                               |   item    |
      // |  [empty]  |                               |   item    |
      // |   item    | <-- bottom            top --> |  [empty]  |
      // |   item    |                               |  [empty]  |
      // |  [empty]  | <-- top            bottom --> |   item    |
      // |  [empty]  |                               |   item    |
      // +-----------+                               +-----------+
      //
      // Adding a value means moving `top` forward by one, removing means
      // moving `bottom` forward by one. After reaching the end, the queue
      // wraps around.
      //
      // When `top === bottom` the current queue is empty and when
      // `top + 1 === bottom` it's full. This wastes a single space of storage
      // but allows much quicker checks.

      class FixedCircularBuffer {
        top: number;
        bottom: number;
        list: Array<FixedCircularBuffer | undefined>;
        next: FixedCircularBuffer | null;

        constructor() {
          this.bottom = 0;
          this.top = 0;
          this.list = $newArrayWithSize(kSize);
          this.next = null;
        }

        isEmpty() {
          return this.top === this.bottom;
        }

        isFull() {
          return ((this.top + 1) & kMask) === this.bottom;
        }

        push(data) {
          this.list[this.top] = data;
          this.top = (this.top + 1) & kMask;
        }

        shift() {
          var { list, bottom } = this;
          const nextItem = list[bottom];
          if (nextItem === undefined) return null;
          list[bottom] = undefined;
          this.bottom = (bottom + 1) & kMask;
          return nextItem;
        }
      }

      class FixedQueue {
        head: FixedCircularBuffer;
        tail: FixedCircularBuffer;

        constructor() {
          this.head = this.tail = new FixedCircularBuffer();
        }

        isEmpty() {
          return this.head.isEmpty();
        }

        push(data) {
          if (this.head.isFull()) {
            // Head is full: Creates a new queue, sets the old queue's `.next` to it,
            // and sets it as the new main queue.
            this.head = this.head.next = new FixedCircularBuffer();
          }
          this.head.push(data);
        }

        shift() {
          const tail = this.tail;
          const next = tail.shift();
          if (tail.isEmpty() && tail.next !== null) {
            // If there is another queue, it forms the new tail.
            this.tail = tail.next;
            tail.next = null;
          }
          return next;
        }
      }

      return new FixedQueue();
    })();

    function processTicksAndRejections() {
      var tock;
      do {
        while ((tock = queue.shift()) !== null) {
          var callback = tock.callback;
          var args = tock.args;
          var frame = tock.frame;
          var restore = $getInternalField($asyncContext, 0);
          $putInternalField($asyncContext, 0, frame);
          try {
            if (args === undefined) {
              callback();
            } else {
              switch (args.length) {
                case 1:
                  callback(args[0]);
                  break;
                case 2:
                  callback(args[0], args[1]);
                  break;
                case 3:
                  callback(args[0], args[1], args[2]);
                  break;
                case 4:
                  callback(args[0], args[1], args[2], args[3]);
                  break;
                default:
                  callback(...args);
                  break;
              }
            }
          } catch (e) {
            reportUncaughtException(e);
          } finally {
            $putInternalField($asyncContext, 0, restore);
          }
        }

        drainMicrotasks();
      } while (!queue.isEmpty());
    }

    $putInternalField(nextTickQueue, 0, 0);
    $putInternalField(nextTickQueue, 1, queue);
    $putInternalField(nextTickQueue, 2, processTicksAndRejections);
    setup = undefined;
  };

  function nextTick(cb, args) {
    validateFunction(cb);
    if (setup) {
      setup();
      process = globalThis.process;
    }
    if (process._exiting) return;

    queue.push({
      callback: cb,
      args: $argumentCount() > 1 ? Array.prototype.slice.$call(arguments, 1) : undefined,
      frame: $getInternalField($asyncContext, 0),
    });
    $putInternalField(nextTickQueue, 0, 1);
  }

  return nextTick;
}

$getter;
export function mainModule() {
  var existing = $getByIdDirectPrivate(this, "main");
  // note: this doesn't handle "process.mainModule = undefined"
  if (typeof existing !== "undefined") {
    return existing;
  }

  return $requireMap.$get(Bun.main);
}

$overriddenName = "set mainModule";
export function setMainModule(value) {
  $putByIdDirectPrivate(this, "main", value);
  return true;
}
