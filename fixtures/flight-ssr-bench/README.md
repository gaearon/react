# Flight SSR Benchmark

Measures the performance overhead of the React Server Components (RSC) Flight pipeline compared to plain Fizz server-side rendering, across both Node and Edge (web streams) APIs.

## Prerequisites

Build React from the repo root first:

```sh
yarn build-for-flight-prod
```

Then install the fixture's dependencies:

```sh
cd fixtures/flight-ssr-bench
yarn install
```

## Scripts

| Script | Purpose |
| --- | --- |
| `yarn bench` | Sequential benchmark with Flight script injection (realistic framework pipeline). Best for measuring Edge vs Node overhead. |
| `yarn bench:bare` | Sequential benchmark without script injection. Best for measuring React-internal changes (e.g. Flight serialization optimizations) with less noise from stream plumbing. |
| `yarn bench:server` | HTTP server benchmark using autocannon at c=1 and c=10. Best for measuring real-world req/s. The c=1 results are also useful for tracking React-internal changes. |
| `yarn bench:concurrent` | In-process concurrent benchmark (50 in-flight renders). Measures throughput under load without HTTP overhead. |
| `yarn bench:profile` | CPU profiling via V8 inspector. Saves `.cpuprofile` files to `build/profiles/`. |
| `yarn bench:fragmented` | Row-fragmentation deep dive for [#35125](https://github.com/facebook/react/issues/35125) (production build). See below. |
| `yarn bench:fragmented:dev` | Same, with development builds (throws and lazy bookkeeping cost differently in dev). Requires a dev build of React (see below). |
| `yarn start` | Starts the HTTP server for manual browser testing at `http://localhost:3001`. Append `.rsc` to any Flight URL to see the raw Flight payload. |

### Dev builds for `bench:fragmented:dev`

`yarn build-for-flight-prod` only produces production artifacts. To run the dev
variant, build dev artifacts first and merge them in:

```sh
yarn build-for-flight-dev
mv build/oss-experimental /tmp/oss-experimental-dev
yarn build-for-flight-prod
rsync -a --include='*/' --include='*.development.js' --exclude='*' \
  /tmp/oss-experimental-dev/ build/oss-experimental/
```

## What it measures

Each script benchmarks 8 render variants:

- **Fizz (Node, sync/async)** -- plain `renderToPipeableStream`, no RSC
- **Fizz (Edge, sync/async)** -- plain `renderToReadableStream`, no RSC
- **Flight + Fizz (Node, sync/async)** -- full RSC pipeline: Flight server (`renderToPipeableStream`) -> Flight client (`createFromNodeStream`) -> Fizz (`renderToPipeableStream`)
- **Flight + Fizz (Node, channel, sync/async)** -- same pipeline but the SSR pass consumes the render through a `ModelChannel` (`createFromModelChannel`) instead of parsing the byte stream, which also removes the need to tee the Flight stream for script injection
- **Flight + Fizz (Edge, sync/async)** -- full RSC pipeline: Flight server (`renderToReadableStream`) -> Flight client (`createFromReadableStream`) -> Fizz (`renderToReadableStream`)

The "sync" variants use a fully synchronous app (no Suspense boundaries). The "async" variants use per-row async components with staggered delays and individual Suspense boundaries (~250 boundaries per render).

`bench.js` additionally runs Node-only "fragmented" variants using the row-fragmentation app described below.

### Row fragmentation (`yarn bench:fragmented`)

[#35125](https://github.com/facebook/react/issues/35125) reports that Flight's `MAX_ROW_SIZE=3200` deferral degenerates on pages with many flat siblings: Server Components flatten into their parent's row, so once the accumulated row crosses the limit, `deferTask` outlines **every remaining sibling in the tree** into its own `$L` lazy row — thousands of rows averaging ~60 bytes. `src/AppFragmented.js` reproduces the shape from [mhart's repro](https://github.com/mhart/react-server-defer-task): 20 sections of ~103 sibling paragraphs, no Suspense, no client components.

Two hypotheses compete in the issue thread for where the resulting time goes:

1. **Per-row overhead** (mhart) — emitting, framing, and parsing thousands of tiny rows.
2. **Lazy/throw machinery** (gnoff) — each deferred row is a throw-based lazy on the client, so the SSR pass throws, spawns suspended tasks, and retries thousands of times.

`bench-fragmented.js` separates them:

- **Row stats** — scans the raw Flight payload with the client's framing rules and reports row count and mean row size for newline-terminated rows (length-prefixed `T`/binary rows are tallied separately so their framing doesn't skew the mean).
- **Replay A/B** — replays the *same captured payload bytes* through Flight client + Fizz in two modes: `buffered` (every row resolved before Fizz starts → `readChunk` never throws) and `streamed` (rows arrive one macrotask apart → full throw/suspend/retry path, with both natural and worst-case one-chunk-per-row boundaries). The difference isolates the lazy/throw machinery from the per-row parse cost, which is itself isolated by comparing the buffered replay against plain Fizz.
- **CPU profile attribution** — buckets V8 self-time into Flight server / Flight client row-parse / Flight client lazy-throw / Fizz render / Fizz suspend-retry, with top functions per bucket. Profiles land in `build/profiles/fragmented-*.cpuprofile`.

Run it under both `yarn bench:fragmented` (prod) and `yarn bench:fragmented:dev` (dev) — throws capture stacks and extra bookkeeping in development, so the two hypotheses weigh differently per channel.

#### Example results (M-series MacBook Pro, Node 24, July 2026)

Fragmentation reproduces: the ~148KB fragmented payload emits **1043 rows, median 56 bytes** (vs the dashboard app's 253 rows averaging 1288 bytes for a payload 2.2x the size). In dev the payload is 552KB across **4538 rows** (1227 of them debug-info rows).

Production, medians per render (83KB HTML page):

| Measurement | ms |
| --- | --- |
| Fizz only | 0.58 |
| Full Flight+Fizz pipeline | 2.77 |
| Flight server only (serialize rows) | 1.40 |
| Client row parse cost (buffered replay − Fizz) | 1.44 |
| Throw/suspend cost, natural chunk arrival (net of drip baseline) | 0.08 |
| Throw/suspend cost, worst-case per-row arrival (net of drip baseline) | 1.00 |

Profile self-time of the prod pipeline: Flight server 33.6%, GC 28.1%, client row parse 17.7%, Fizz render 11.8%, client lazy/throw machinery **0.5%**, Fizz suspend/retry **0.1%**. In production, per-row overhead (row emission + row parse + the allocation/GC pressure of ~1000 tiny rows and chunks) dominates and throw-based lazy machinery is negligible — even when every row arrives as its own stream chunk.

In development the picture inverts but not toward throws: dev-only debug-info machinery (fake owner-stack construction via `fakeJSXCallSite`/`buildFakeCallStack`, plus server-side stack collection) accounts for **~80%** of pipeline self-time (~55ms/iter median), while lazy/throw machinery stays ≤0.6%. The buffered replay is *slower* than the streamed one in dev (72ms vs 34ms) because chunks that initialize lazily, nested deep inside the render walk, materialize much more expensive fake stacks than chunks initialized shallowly from stream events — so dev A/B deltas measure debug-stack effects, not throws. (Caveat: the dev Flight server also installs process-wide `async_hooks`/`prepareStackTrace` instrumentation that taxes the replay variants even though they don't run the server.)

### Script injection

The `yarn bench` and `yarn bench:server` scripts simulate what real frameworks do: tee the Flight stream and inject `<script>` hydration tags into the HTML output. This uses a `setTimeout(0)`-buffered Transform/TransformStream to avoid splitting mid-HTML-tag. `yarn bench:bare` skips this for cleaner React-internal measurement.

## Test app

A dashboard with ~25 components (16 client components), rendering:

- 200 product rows with nested reviews, specifications, and supplier data (~325KB Flight payload)
- 50 activity feed items
- Stats grid with 24-month chart data
- Sidebar with navigation and recent activity

## Output

Each variant reports render latency stats, GC pauses, and (when run with `--expose-gc`, which the `yarn bench*` scripts do) the heap retained after the run settles: the benchmark yields to the event loop and forces a GC before reading `heapUsed`, so this number reflects real cross-request retention rather than garbage that hasn't had a chance to be collected. The benchmark loops yield to the event loop between iterations for the same reason: React schedules a `setImmediate` per request, and a loop that never reaches the check phase would accumulate those immediates, each retaining its finished request graph — inflating memory numbers with what is actually a measurement artifact.

The overhead tables show two comparisons:

1. **Flight overhead** -- Flight+Fizz vs Fizz-only (how much RSC adds)
2. **Edge vs Node** -- web streams vs Node streams (stream implementation cost)

Delta is shown as percentage change plus a factor (e.g. `+120% 2.20x` means 2.2x slower).
