// Turns MicMemo Pro's storage file into audio files. Runs in the browser (usb.html)
// and in Node (the tests); nothing here touches the network.
//
// Connect IQ keeps an app's Application.Storage in GARMIN/Apps/DATA as <name>.DAT and
// <name>.IDX. Garmin doesn't document the format; this is what the simulator writes:
//
//   DAT  a series of records, each a key and a value:
//        ABCDABCD <u32 size> <string table>     strings, each <u16 size> <bytes> <0>
//        DA7ADA7A <u32 size> <object>           refers to strings by table offset
//        A value without strings has no string table.
//   IDX  a 0x38-byte header, then 48 bytes per key: its record's offset in the DAT (add
//        16) at +4, little-endian, and a "deleted" flag at +22. It's written lazily, so
//        the newest keys can be missing; those are found by walking the DAT.
//
// The recordings themselves are laid out as described in source/RecordingStore.mc.
(function (root) {
  const STRINGS_MAGIC = 0xabcdabcd;
  const DATA_MAGIC = 0xda7ada7a;
  const IDX_HEADER = 0x38;
  const IDX_ENTRY = 48;
  const IDX_RECORD_SKEW = 16;

  const decoder = new TextDecoder('utf-8');

  // Reads one object from `view` at `pos.at`.
  function readObject(view, pos, strings) {
    const type = view.getUint8(pos.at);
    pos.at += 1;
    switch (type) {
      case 0x00: // null
        return null;
      case 0x01: { // number
        const value = view.getInt32(pos.at);
        pos.at += 4;
        return value;
      }
      case 0x02: { // float
        const value = view.getFloat32(pos.at);
        pos.at += 4;
        return value;
      }
      case 0x03: { // string, as an offset into the string table
        const offset = view.getUint32(pos.at);
        pos.at += 4;
        return readString(strings, offset);
      }
      case 0x05: { // array
        const count = view.getUint32(pos.at);
        pos.at += 4;
        const items = [];
        for (let i = 0; i < count; i++) {
          items.push(readObject(view, pos, strings));
        }
        return items;
      }
      case 0x09: { // boolean
        const value = view.getUint8(pos.at) !== 0;
        pos.at += 1;
        return value;
      }
      case 0x0a: // char
        pos.at += 4;
        return null;
      case 0x0b: { // dictionary
        const count = view.getUint32(pos.at);
        pos.at += 4;
        const dict = {};
        for (let i = 0; i < count; i++) {
          const key = readObject(view, pos, strings);
          dict[key] = readObject(view, pos, strings);
        }
        return dict;
      }
      case 0x0e: // long
      case 0x0f: // double
        pos.at += 8;
        return null;
      case 0x14: { // byte array
        const size = view.getUint32(pos.at);
        pos.at += 4;
        const bytes = new Uint8Array(view.buffer, view.byteOffset + pos.at, size);
        pos.at += size;
        return bytes;
      }
      default:
        throw new Error('unknown object type ' + type);
    }
  }

  function readString(strings, offset) {
    if (strings === null) {
      throw new Error('string without a string table');
    }
    const size = strings.getUint16(offset);
    const bytes = new Uint8Array(strings.buffer, strings.byteOffset + offset + 2, size - 1);
    return decoder.decode(bytes);
  }

  // Reads an optional string table and an object at `at`. Returns the object and where it ends.
  function readSection(view, at) {
    let strings = null;
    if (view.getUint32(at) === STRINGS_MAGIC) {
      const size = view.getUint32(at + 4);
      strings = new DataView(view.buffer, view.byteOffset + at + 8, size);
      at += 8 + size;
    }
    if (view.getUint32(at) !== DATA_MAGIC) {
      throw new Error('no data section');
    }
    const size = view.getUint32(at + 4);
    const body = at + 8;
    const pos = { at: body };
    const value = readObject(view, pos, strings);
    if (pos.at !== body + size) {
      throw new Error('object size mismatch');
    }
    return { value: value, end: body + size };
  }

  // A key and value at `at`, or null if that isn't where a record starts.
  function readRecord(view, at) {
    try {
      const key = readSection(view, at);
      if (typeof key.value !== 'string') {
        return null;
      }
      const value = readSection(view, key.end);
      return { key: key.value, value: value.value, start: at, end: value.end };
    } catch (e) {
      return null; // Ran off the end or hit something else; keep looking.
    }
  }

  // Every record in the DAT, in file order.
  function walkRecords(view) {
    const records = [];
    let at = 0;
    while (at + 8 <= view.byteLength) {
      if (view.getUint32(at) === STRINGS_MAGIC) {
        const record = readRecord(view, at);
        if (record !== null) {
          records.push(record);
          at = record.end;
          continue;
        }
      }
      at += 1;
    }
    return records;
  }

  // The live key/value pairs. The IDX, when it has a key, says which of its records counts
  // and whether it's deleted; otherwise the last record for the key does.
  function readValues(dat, idx) {
    const view = new DataView(dat.buffer, dat.byteOffset, dat.byteLength);
    const records = walkRecords(view);
    const byStart = new Map(records.map((record) => [record.start, record]));
    const values = new Map();
    for (const record of records) {
      values.set(record.key, record.value);
    }
    if (idx) {
      const index = new DataView(idx.buffer, idx.byteOffset, idx.byteLength);
      for (let at = IDX_HEADER; at + 24 <= index.byteLength; at += IDX_ENTRY) {
        const record = byStart.get(index.getUint32(at + 4, true) + IDX_RECORD_SKEW);
        if (record === undefined) {
          continue;
        }
        if (index.getUint8(at + 22) === 0) {
          values.set(record.key, record.value);
        } else if (values.get(record.key) === record.value) {
          values.delete(record.key);
        }
      }
    }
    return values;
  }

  function concat(parts) {
    const total = parts.reduce((sum, part) => sum + part.length, 0);
    const out = new Uint8Array(total);
    let at = 0;
    for (const part of parts) {
      out.set(part, at);
      at += part.length;
    }
    return out;
  }

  // Each WAV capture window starts with a header describing only that window, and the
  // recording keeps just the first; see source/Wav.mc.
  function fixWavSizes(data) {
    if (String.fromCharCode(data[0], data[1], data[2], data[3]) !== 'RIFF') {
      return;
    }
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    view.setUint32(4, data.length - 8, true);
    let at = 12;
    while (at + 8 <= data.length) {
      if (String.fromCharCode(data[at], data[at + 1], data[at + 2], data[at + 3]) === 'data') {
        view.setUint32(at + 4, data.length - at - 8, true);
        return;
      }
      const size = view.getUint32(at + 4, true);
      at += 8 + size + size % 2; // Chunks are padded to an even length.
    }
  }

  function pad(number) {
    return String(number).padStart(2, '0');
  }

  // "2026-11-07 09-30 Shopping list.ogg", safe on Windows, macOS and Linux.
  function fileName(info, id) {
    const date = new Date((info.time || 0) * 1000);
    const stamp = date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) +
      ' ' + pad(date.getHours()) + '-' + pad(date.getMinutes());
    const name = typeof info.name === 'string' ? info.name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '').trim() : '';
    const extension = info.format === 'wav' ? 'wav' : 'ogg';
    return stamp + (name ? ' ' + name : ' #' + id) + '.' + extension;
  }

  // Returns the recordings in a DAT (and its IDX, if available), oldest first, or null if
  // this isn't MicMemo Pro's file. Each has id, name, time, ms, format, location ({latitude,
  // longitude} in degrees, or null), fileName, mimeType, data (the whole audio file) and
  // complete (false if any audio is missing).
  function extractRecordings(dat, idx) {
    const values = readValues(dat, idx);
    const ids = values.get('ids');
    if (!Array.isArray(ids) || !values.has('nextId')) {
      return null;
    }
    const recordings = [];
    for (const id of ids) {
      const info = values.get('r' + id);
      if (!info || typeof info !== 'object' || typeof info.chunks !== 'number') {
        continue;
      }
      const parts = [];
      let complete = true;
      for (let n = 0; n < info.chunks; n++) {
        const chunk = values.get('r' + id + '.' + n);
        if (chunk instanceof Uint8Array) {
          parts.push(chunk);
        } else {
          complete = false;
        }
      }
      const data = concat(parts);
      if (info.format === 'wav' && data.length > 44) {
        fixWavSizes(data);
      }
      recordings.push({
        id: id,
        name: typeof info.name === 'string' ? info.name : null,
        time: info.time,
        ms: info.ms,
        format: info.format,
        location: typeof info.lat === 'number' && typeof info.lon === 'number'
          ? { latitude: info.lat / 1000000, longitude: info.lon / 1000000 }
          : null,
        fileName: fileName(info, id),
        mimeType: info.format === 'wav' ? 'audio/wav' : 'audio/ogg',
        data: data,
        complete: complete,
      });
    }
    return recordings;
  }

  root.MicMemoExtract = { extractRecordings: extractRecordings };
})(typeof globalThis !== 'undefined' ? globalThis : this);
