// Test harness: a kino.* shim for Node where kino.fetch is backed by curl
// (curl's TLS fingerprint passes njavtv.com's Cloudflare; Node's does not).
// Loads the real plugin.js and runs home/search/browse/resolve end to end.
import { execFileSync } from "node:child_process";

const UA = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36";

function curlFetch(url, options = {}) {
  const args = [
    "-s", "-L", "--max-time", String(Math.ceil((options.timeoutMs || 15000) / 1000)),
    "-w", "\n@@@META@@@%{http_code}@@@%{url_effective}",
    "-A", UA,
  ];
  const headers = Object.assign({}, options.headers || {});
  for (const [k, v] of Object.entries(headers)) {
    args.push("-H", `${k}: ${v}`);
  }
  if (options.method === "POST") args.push("-X", "POST");
  if (options.body) args.push("--data-binary", String(options.body));
  args.push(url);
  const out = execFileSync("curl", args, { maxBuffer: 64 * 1024 * 1024, encoding: "buffer" });
  const text = out.toString("utf8");
  const marker = "\n@@@META@@@";
  const at = text.lastIndexOf(marker);
  const body = at >= 0 ? text.slice(0, at) : text;
  const meta = at >= 0 ? text.slice(at + marker.length) : "000@@@";
  const status = Number(meta.split("@@@")[0]) || 0;
  return {
    ok: status >= 200 && status <= 299,
    status,
    url,
    headers: {},
    // KinoResponse.text()/json()/base64() are SYNCHRONOUS in the app
    // (kino.d.ts: text(): string). Keep them sync here so the harness has the
    // same shape as the device runtime -- a .then() on them must fail here too.
    text: () => body,
    json: () => JSON.parse(body),
    base64: () => Buffer.from(body).toString("base64"),
    truncated: false,
  };
}

globalThis.kino = {
  fetch: (url, options) => Promise.resolve(curlFetch(url, options)),
  log: (...args) => console.error("[kino.log]", ...args),
  // The app's cookie jar: kino.fetch stores __cf_bm for surrit.com on the
  // first 200 and the plugin replays it into the stream's player headers.
  cookies: {
    get: (url, name) =>
      name === "__cf_bm" && /(^|\.)surrit\.com$/.test(new URL(url).hostname)
        ? "harnesscfbmsamplevaluefortests"
        : null,
  },
  error: (code, message, extra) => {
    const e = new Error(`${code}: ${message}`);
    e.code = code;
    e.name = `KinoError_${code}`;
    if (extra && extra.userMessage) e.userMessage = extra.userMessage;
    return e;
  },
  sleep: async () => {},
  storage: { get: () => null, set: () => {}, remove: () => {}, keys: () => [] },
  config: { get: () => undefined, all: () => ({}) },
  device: "phone",
  lang: "es-CO",
  rank: {
    shortQuery: (q) => q,
    sortBySimilarity: (items) => items,
    filterRelevant: (items) => items,
  },
};

const plugin = await import("./plugin.js");

const arg = process.argv[2];
const a1 = process.argv[3];
const a2 = process.argv[4];

if (arg === "home") {
  const rows = await plugin.home();
  console.log(JSON.stringify({ rows: rows.map((r) => ({ id: r.id, title: r.title, items: r.items.length, first: r.items[0] && r.items[0].title.slice(0, 50) })) }, null, 1));
} else if (arg === "search") {
  const page = await plugin.search({ q: a1 || "snos", type: "any", season: 0, episode: 0, tmdbId: 0, year: 0, originalTitle: "", altTitles: [], cursor: a2 || null });
  console.log(JSON.stringify({ count: page.items ? page.items.length : 0, next: page.next, first: page.items && page.items[0] }, null, 1));
} else if (arg === "browse") {
  const page = await plugin.browse(a1, a2 || null);
  console.log(JSON.stringify({ count: page.items.length, next: page.next, first: page.items[0] && page.items[0].title.slice(0, 50), last: page.items[page.items.length - 1] && page.items[page.items.length - 1].title.slice(0, 50) }, null, 1));
} else if (arg === "resolve") {
  const stream = await plugin.resolve(a1);
  console.log(JSON.stringify(stream, null, 1));
} else if (arg === "sign") {
  // Kino calls sign() for every playlist/segment request of a signed stream.
  const req = typeof a1 === "string" && a1.trim().startsWith("{") ? JSON.parse(a1) : { url: a1 || "https://c.surrit.com/00000000-0000-0000-0000-000000000000/playlist.m3u8", kind: a2 || "playlist", ref: "test", context: "" };
  const out = await plugin.sign(req);
  console.log(JSON.stringify(out, null, 1));
} else {
  console.log("usage: node harness.mjs home | search <q> [cursor] | browse <ref> [cursor] | resolve <ref> | sign [json|url] [kind]");
}
