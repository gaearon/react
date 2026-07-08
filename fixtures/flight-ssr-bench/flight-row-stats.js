'use strict';

// Row-level statistics for a raw Flight (RSC) payload.
//
// Mirrors the row framing state machine in
// packages/react-client/src/ReactFlightClient.js (processBinaryChunk):
//
//   row := rowID ":" [tag] body
//
// Tags T, A, O, o, b, U, S, s, L, l, G, g, M, m, V are length-prefixed
// ("<hexlen>," followed by that many bytes, possibly containing newlines).
// Every other row (tagged A-Z / # / r / x, or untagged JSON models) is
// terminated by a newline.
//
// This is used to quantify the row fragmentation described in
// https://github.com/facebook/react/issues/35125: newline-terminated model
// rows are counted separately from length-prefixed text/binary rows so the
// "mean row size" number isn't skewed by large T rows' framing.

const LENGTH_PREFIXED_TAGS = new Set([
  84, // T
  65, // A
  79, // O
  111, // o
  98, // b
  85, // U
  83, // S
  115, // s
  76, // L
  108, // l
  71, // G
  103, // g
  77, // M
  109, // m
  86, // V
]);

function isNewlineTag(byte) {
  return (
    (byte > 64 && byte < 91) /* A-Z */ ||
    byte === 35 /* # */ ||
    byte === 114 /* r */ ||
    byte === 120 /* x */
  );
}

// buffer: Buffer or Uint8Array containing the complete Flight payload.
// Returns rows with their byte offsets and framing kind.
function scanFlightRows(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const rows = [];
  let i = 0;
  while (i < buf.length) {
    const rowStart = i;
    // rowID: hex digits up to ':'
    while (i < buf.length && buf[i] !== 58 /* ":" */) {
      i++;
    }
    if (i >= buf.length) {
      break; // trailing partial row
    }
    i++; // skip ':'
    let tag = 0;
    let lengthPrefixed = false;
    const tagByte = buf[i];
    if (LENGTH_PREFIXED_TAGS.has(tagByte)) {
      tag = tagByte;
      lengthPrefixed = true;
      i++;
      let rowLength = 0;
      while (i < buf.length && buf[i] !== 44 /* "," */) {
        const byte = buf[i++];
        rowLength = (rowLength << 4) | (byte > 96 ? byte - 87 : byte - 48);
      }
      i++; // skip ','
      i += rowLength; // body: exactly rowLength bytes, no trailing newline
    } else {
      if (isNewlineTag(tagByte)) {
        tag = tagByte;
        i++;
      }
      // Untagged bytes are part of the JSON model itself.
      const newlineIdx = buf.indexOf(10 /* "\n" */, i);
      i = newlineIdx === -1 ? buf.length : newlineIdx + 1;
    }
    rows.push({
      tag: tag === 0 ? 'model' : String.fromCharCode(tag),
      lengthPrefixed,
      start: rowStart,
      // Full on-the-wire size of the row including id/tag/length framing
      // and the trailing newline for newline-terminated rows.
      bytes: Math.min(i, buf.length) - rowStart,
    });
  }
  return rows;
}

function analyzeFlightPayload(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const rows = scanFlightRows(buf);

  const newlineRows = rows.filter(r => !r.lengthPrefixed);
  const prefixedRows = rows.filter(r => r.lengthPrefixed);
  const newlineSizes = newlineRows.map(r => r.bytes).sort((a, b) => a - b);
  const sum = arr => arr.reduce((s, v) => s + v, 0);

  const byTag = new Map();
  for (const row of rows) {
    const entry = byTag.get(row.tag) || {count: 0, bytes: 0};
    entry.count++;
    entry.bytes += row.bytes;
    byTag.set(row.tag, entry);
  }

  return {
    totalBytes: buf.length,
    totalRows: rows.length,
    newlineRowCount: newlineRows.length,
    newlineRowBytes: sum(newlineSizes),
    newlineRowMean: newlineSizes.length
      ? sum(newlineSizes) / newlineSizes.length
      : 0,
    newlineRowMedian: newlineSizes.length
      ? newlineSizes[Math.floor(newlineSizes.length / 2)]
      : 0,
    newlineRowMin: newlineSizes.length ? newlineSizes[0] : 0,
    newlineRowMax: newlineSizes.length
      ? newlineSizes[newlineSizes.length - 1]
      : 0,
    prefixedRowCount: prefixedRows.length,
    prefixedRowBytes: sum(prefixedRows.map(r => r.bytes)),
    byTag,
  };
}

function printFlightRowStats(label, stats) {
  console.log('  %s:', label);
  console.log('    Payload:            %d bytes', stats.totalBytes);
  console.log('    Rows:               %d', stats.totalRows);
  console.log(
    '    Newline rows:       %d (%d bytes, mean %s, median %d, min %d, max %d)',
    stats.newlineRowCount,
    stats.newlineRowBytes,
    stats.newlineRowMean.toFixed(1),
    stats.newlineRowMedian,
    stats.newlineRowMin,
    stats.newlineRowMax
  );
  console.log(
    '    Length-prefixed:    %d rows (%d bytes, T/binary framing excluded from means)',
    stats.prefixedRowCount,
    stats.prefixedRowBytes
  );
  const tags = [...stats.byTag.entries()].sort(
    (a, b) => b[1].count - a[1].count
  );
  for (const [tag, entry] of tags) {
    console.log(
      '      tag %s: %d rows, %d bytes',
      tag === 'model' ? 'model (untagged)' : JSON.stringify(tag),
      entry.count,
      entry.bytes
    );
  }
}

// Split a complete Flight payload into one Buffer per row. Used to replay
// the payload with worst-case arrival granularity (every row is its own
// stream chunk, like a heavily fragmented network transfer).
function splitFlightPayloadRows(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const rows = scanFlightRows(buf);
  const chunks = rows.map(r => buf.subarray(r.start, r.start + r.bytes));
  const lastRow = rows[rows.length - 1];
  const consumed = lastRow ? lastRow.start + lastRow.bytes : 0;
  if (consumed < buf.length) {
    chunks.push(buf.subarray(consumed));
  }
  return chunks;
}

module.exports = {
  analyzeFlightPayload,
  printFlightRowStats,
  splitFlightPayloadRows,
};
