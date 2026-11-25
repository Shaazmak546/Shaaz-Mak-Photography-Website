/*
 * Album ZIP download service worker (scope: /zip-sw/ only, it controls nothing else).
 *
 * The page sends a list of photo URLs + file names, then opens
 * /zip-sw/download/<id>/<name>.zip in a hidden iframe. This worker answers that
 * request with a streamed "store" ZIP (originals byte-for-byte, ZIP64 when over
 * 4 GB) built while it downloads the photos a few at a time. The browser saves
 * it like any normal download, so memory stays at a few photos no matter how
 * big the album is. Works in Chrome, Edge, Firefox and Safari.
 *
 * Keep the ZIP layout in sync with src/lib/zipWriter.ts.
 */
"use strict";

const CONCURRENCY = 3;
const FETCH_ATTEMPTS = 4;
const FETCH_TIMEOUT_MS = 90000;
const JOB_TTL_MS = 5 * 60 * 1000;

/** id -> { files, zipName, port, cancelled, created, cancelStream? } */
const jobs = new Map();

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("message", (event) => {
  const data = event.data || {};
  if (data.type === "job" && event.ports[0]) {
    for (const [id, j] of jobs) if (!j.started && Date.now() - j.created > JOB_TTL_MS) jobs.delete(id);
    jobs.set(data.id, {
      files: Array.isArray(data.files) ? data.files : [],
      zipName: String(data.zipName || "album.zip"),
      port: event.ports[0],
      cancelled: false,
      started: false,
      created: Date.now(),
    });
    event.ports[0].postMessage({ type: "ready" });
  } else if (data.type === "cancel") {
    const job = jobs.get(data.id);
    if (job) {
      job.cancelled = true;
      if (job.cancelStream) job.cancelStream();
    }
  }
  // "ping" needs no handling: receiving any message keeps this worker awake.
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  const m = url.pathname.match(/^\/zip-sw\/download\/([A-Za-z0-9-]{8,64})(\/|$)/);
  if (!m) return;
  const job = jobs.get(m[1]);
  if (!job || job.started) {
    event.respondWith(
      new Response("This download link has expired. Go back to the album and click Download again.", {
        status: 404,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      }),
    );
    return;
  }
  job.started = true;
  const ascii = job.zipName.replace(/[^\x20-\x7e]|["\\]/g, "_");
  event.respondWith(
    new Response(zipStream(m[1], job), {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(job.zipName)}`,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    }),
  );
});

function post(job, msg) {
  try {
    job.port.postMessage(msg);
  } catch (e) {
    /* page went away; the download itself keeps going */
  }
}

function zipStream(id, job) {
  const it = zipChunks(job);
  let finished = false;
  const finish = () => {
    finished = true;
    jobs.delete(id);
  };
  return new ReadableStream(
    {
      start(controller) {
        post(job, { type: "started" });
        job.cancelStream = () => {
          if (finished) return;
          finish();
          post(job, { type: "cancelled" });
          try {
            controller.error(new Error("Download cancelled"));
          } catch (e) {
            /* already closed */
          }
        };
      },
      async pull(controller) {
        try {
          const { value, done } = await it.next();
          if (finished) return;
          if (done) {
            finish();
            controller.close();
          } else {
            controller.enqueue(value);
          }
        } catch (err) {
          if (finished) return;
          finish();
          post(job, { type: job.cancelled ? "cancelled" : "error", message: String((err && err.message) || err) });
          controller.error(err);
        }
      },
      cancel() {
        // The user cancelled in the browser's download list.
        job.cancelled = true;
        if (!finished) {
          finish();
          post(job, { type: "cancelled" });
        }
      },
    },
    { highWaterMark: 1 },
  );
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchPhoto(job, url) {
  for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt++) {
    if (job.cancelled) throw new Error("Download cancelled");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: controller.signal, credentials: "omit", cache: "no-store" });
      if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) return null;
      if (!res.ok) throw new Error("HTTP " + res.status);
      const bytes = new Uint8Array(await res.arrayBuffer());
      const expected = Number(res.headers.get("content-length"));
      if (expected && bytes.length !== expected) throw new Error("Incomplete download");
      return bytes;
    } catch (e) {
      if (job.cancelled) throw new Error("Download cancelled");
    } finally {
      clearTimeout(timer);
    }
    if (attempt < FETCH_ATTEMPTS) await sleep(500 * 2 ** (attempt - 1));
  }
  return null;
}

// ---- ZIP writing (store only; mirrors src/lib/zipWriter.ts) ----

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(data) {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const U32_MAX = 0xffffffff;
const U16_MAX = 0xffff;
const encoder = new TextEncoder();

function dos(date) {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

function localHeader(name, crc, size, t) {
  const h = new Uint8Array(30 + name.length);
  const v = new DataView(h.buffer);
  v.setUint32(0, 0x04034b50, true);
  v.setUint16(4, 20, true);
  v.setUint16(6, 0x0800, true);
  v.setUint16(8, 0, true);
  v.setUint16(10, t.time, true);
  v.setUint16(12, t.date, true);
  v.setUint32(14, crc, true);
  v.setUint32(18, size, true);
  v.setUint32(22, size, true);
  v.setUint16(26, name.length, true);
  v.setUint16(28, 0, true);
  h.set(name, 30);
  return h;
}

function centralRecord(e) {
  const big = e.offset >= U32_MAX;
  const extraLen = big ? 12 : 0;
  const rec = new Uint8Array(46 + e.name.length + extraLen);
  const v = new DataView(rec.buffer);
  v.setUint32(0, 0x02014b50, true);
  v.setUint16(4, big ? 45 : 20, true);
  v.setUint16(6, big ? 45 : 20, true);
  v.setUint16(8, 0x0800, true);
  v.setUint16(10, 0, true);
  v.setUint16(12, e.t.time, true);
  v.setUint16(14, e.t.date, true);
  v.setUint32(16, e.crc, true);
  v.setUint32(20, e.size, true);
  v.setUint32(24, e.size, true);
  v.setUint16(28, e.name.length, true);
  v.setUint16(30, extraLen, true);
  v.setUint32(42, big ? U32_MAX : e.offset, true);
  rec.set(e.name, 46);
  if (big) {
    const x = 46 + e.name.length;
    v.setUint16(x, 0x0001, true);
    v.setUint16(x + 2, 8, true);
    v.setBigUint64(x + 4, BigInt(e.offset), true);
  }
  return rec;
}

function endRecords(count, cdStart, cdSize, eocd64Offset) {
  const needZip64 = count >= U16_MAX || cdStart >= U32_MAX || cdSize >= U32_MAX;
  const out = new Uint8Array((needZip64 ? 76 : 0) + 22);
  const v = new DataView(out.buffer);
  let o = 0;
  if (needZip64) {
    v.setUint32(0, 0x06064b50, true);
    v.setBigUint64(4, 44n, true);
    v.setUint16(12, 45, true);
    v.setUint16(14, 45, true);
    v.setBigUint64(24, BigInt(count), true);
    v.setBigUint64(32, BigInt(count), true);
    v.setBigUint64(40, BigInt(cdSize), true);
    v.setBigUint64(48, BigInt(cdStart), true);
    v.setUint32(56, 0x07064b50, true);
    v.setBigUint64(64, BigInt(eocd64Offset), true);
    v.setUint32(72, 1, true);
    o = 76;
  }
  v.setUint32(o, 0x06054b50, true);
  v.setUint16(o + 8, needZip64 ? U16_MAX : count, true);
  v.setUint16(o + 10, needZip64 ? U16_MAX : count, true);
  v.setUint32(o + 12, needZip64 ? U32_MAX : cdSize, true);
  v.setUint32(o + 16, needZip64 ? U32_MAX : cdStart, true);
  return out;
}

async function* zipChunks(job) {
  const files = job.files;
  const total = files.length;
  const entries = [];
  const failed = [];
  let offset = 0;
  const t = dos(new Date());

  const inFlight = [];
  let next = 0;
  const launch = () => {
    while (next < total && inFlight.length < CONCURRENCY) {
      const p = fetchPhoto(job, files[next].url);
      p.catch(() => undefined);
      inFlight.push(p);
      next++;
    }
  };

  function* entry(nameStr, data) {
    const name = encoder.encode(nameStr);
    const crc = crc32(data);
    const header = localHeader(name, crc, data.length, t);
    entries.push({ name, crc, size: data.length, offset, t });
    offset += header.length + data.length;
    yield header;
    yield data;
  }

  post(job, { type: "progress", done: 0, total });
  launch();
  for (let i = 0; i < total; i++) {
    const data = await inFlight.shift();
    launch();
    if (job.cancelled) throw new Error("Download cancelled");
    if (data) yield* entry(String(files[i].name), data);
    else failed.push(String(files[i].name));
    post(job, { type: "progress", done: i + 1, total });
  }

  if (failed.length > 0) {
    const note = "These photos could not be downloaded and are not in this ZIP:\r\n\r\n" + failed.join("\r\n") + "\r\n";
    yield* entry("_missing_photos.txt", encoder.encode(note));
  }

  const cdStart = offset;
  for (const e of entries) {
    const rec = centralRecord(e);
    offset += rec.length;
    yield rec;
  }
  yield endRecords(entries.length, cdStart, offset - cdStart, offset);
  post(job, { type: "done", saved: entries.length - (failed.length > 0 ? 1 : 0), failed });
}
