'use strict';

// Commands in a capture identify data sections only. Nothing is transmitted.
function inspectCapture(buffer, layout, initialStream = null) {
  if (initialStream && !layout.streams[initialStream]) throw new Error('Unknown continuation stream');
  const sections = new Map();
  const notes = [];
  let stream = initialStream;
  const add = (key, line) => {
    if (!sections.has(key)) sections.set(key, new Set());
    sections.get(key).add(line);
  };
  buffer.toString('utf8').replace(/^\uFEFF/, '').split(/\r?\n/).forEach((original, index) => {
    const line = original.replace(/^>\s*/, '').trim();
    if (!line || line.startsWith(';')) return;
    const memory = line.match(/^mem\s+(\d+)\s+(?:searchb|last)\b/i);
    if (memory) {
      stream = 'mem' + memory[1];
      if (!layout.streams[stream]) throw new Error('Unmapped memory at line ' + (index + 1));
      notes.push({ line: index + 1, kind: 'command', stream });
    } else if (/^r3$/i.test(line)) {
      stream = 'r3';
    } else if (/^\\?END OF DATA$/i.test(line)) {
      notes.push({ line: index + 1, kind: 'completed', stream });
      stream = null;
    } else if (/^DEBUG\s*:/i.test(line)) {
      notes.push({ line: index + 1, kind: 'diagnostic', text: line });
    } else {
      if (!stream) throw new Error('Data without a verified stream at line ' + (index + 1));
      // Include partial lines so the ordinary importer quarantines them and
      // preserves their original line numbers, rather than silently dropping them.
      add(stream, index + 1);
    }
  });
  return { sections, notes, unfinishedStream: stream };
}

function importCapture(store, buffer, { name, verifiedSerial, initialStream = null }) {
  const inspected = inspectCapture(buffer, store.layout, initialStream);
  const imports = [];
  for (const [stream, selectedLineNumbers] of inspected.sections) {
    imports.push({ stream, ...store.importBuffer(buffer, {
      name, stream, format: 'terminal', verifiedSerial, selectedLineNumbers
    }) });
  }
  return { name, imports, notes: inspected.notes, unfinishedStream: inspected.unfinishedStream };
}

module.exports = { inspectCapture, importCapture };
