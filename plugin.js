// Kino plugin: nJAV (njavtv.com) — free JAV streaming catalog.
// Author: Hotaru Yume (creator: hotaruyume)
//
// How it works:
// - Lists/search pages are plain HTML: cards carry a cover URL
//   https://fourhoi.com/{dvd_id}/cover-t.jpg, a duration and the title.
// - Each video page embeds its HLS source inside a Dean Edwards packed script
//   (eval(function(p,a,c,k,e,d){...}('...',15,15,'words'.split('|'),0,{}))). We
//   unpack it with plain string substitution (no eval) to get
//   https://{surrit-host}/{uuid}/playlist.m3u8 plus direct variants.
// - The page HTML is cached by the site for up to 12 h and the CDN bucket can
//   move, so resolve() verifies candidates in parallel (packer host first,
//   then c./b./plain surrit.com) and plays the first manifest that answers
//   "#EXTM3U". The surrit CDN sits behind a Cloudflare WAF that refuses (403)
//   any request missing the site Referer, a real browser User-Agent or the
//   __cf_bm bot-management cookie. kino.fetch sends the cookie from the
//   plugin's jar (that is why the verification passes), but neither the
//   player nor Kino's playback proxy shares that jar — so resolve() reads
//   the cookie with kino.cookies.get() and sends it back on every player
//   request: in the stream's headers and, via signContext, from sign()
//   (signing: "request" plays everything through Kino's local proxy and
//   re-applies the headers per request, which also fixes TV players that
//   drop stream headers on direct playback).
// - Ads (popunders, tsyndicate, myavlive, adsterra...) are never touched: the
//   plugin reads only card markup and the packed video script, nothing else.
//
// All items are marked adult: true (apiVersion 6): Kino shows them only while
// the person's 18+ code is unlocked on that device.

// Generic browser user agent: njavtv.com and the video CDN both answer fine to
// a real browser and are picky with unknown clients.
const UA =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36";
const SITE = "https://njavtv.com";
const IMG = "https://fourhoi.com";

// Headers for HTML page fetches (lists, search, video pages).
const PAGE_HEADERS = {
  "User-Agent": UA,
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

// Headers the video player must send on every request (manifest, variants,
// segments): without the Referer the CDN refuses the manifest.
const STREAM_HEADERS = {
  "User-Agent": UA,
  "Referer": SITE + "/",
};

// Known CDN buckets for the same object path (the page cache may be stale).
const STREAM_HOSTS = ["c.surrit.com", "surrit.com", "b.surrit.com"];

// Kino drops repeated ids and caps every answer; these are the site page
// counts we join per call (12 cards per site page, so 8 pages = 96 items).
const PAGES_PER_ANSWER = 8;
const CARDS_PER_ROW = 2; // pages joined per Home row (24 items)

function log() {
  try {
    kino.log.apply(null, arguments);
  } catch (e) {
    // a log line is never worth the call
  }
}

function decodeEntities(text) {
  return String(text)
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;|&#x0?27;/gi, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&hellip;/gi, "…");
}

function clean(text) {
  return decodeEntities(String(text).replace(/\s+/g, " ")).trim();
}

// "2:31:01" or "45:09" → milliseconds; 0 when unparseable.
function timeToMs(text) {
  const parts = String(text || "").trim().split(":");
  if (!parts.every((p) => /^\d+$/.test(p))) return 0;
  let seconds = 0;
  for (const p of parts) seconds = seconds * 60 + Number(p);
  return seconds > 0 ? seconds * 1000 : 0;
}

// HTML page fetch. Returns the text or null (never throws: callers decide).
// r.text() is sync in the app; await around it keeps the code correct in
// either case (string or Promise).
async function fetchText(url, timeoutMs) {
  await null;
  try {
    const r = await kino.fetch(url, {
      headers: PAGE_HEADERS,
      redirect: "follow",
      timeoutMs: timeoutMs || 12000,
    });
    if (!r.ok) {
      log("fetch", r.status, url);
      return null;
    }
    return await r.text();
  } catch (e) {
    log("fetch failed", (e && (e.code || e.message)) || "error", url);
    return null;
  }
}

// Dean Edwards packer, unpacked without eval: tokens are base-36 indexes into
// the word list, replaced by word boundaries on both sides.
function unpackPacked(packed, words) {
  let text = packed;
  for (let c = words.length - 1; c >= 0; c--) {
    const word = words[c];
    if (!word) continue;
    const token = c.toString(36);
    const pattern = new RegExp("\\b" + token + "\\b", "g");
    // a function replacement keeps '$' in words literal
    text = text.replace(pattern, function () {
      return word;
    });
  }
  return text;
}

// Extract the video sources of a video page:
// { master, high, low } (all absolute https URLs) or null when the page has no
// packed script (gone video, redirect to the home page, or a list page).
function videoSources(html) {
  if (!html) return null;
  const call = /eval\(function\(p,a,c,k,e,d\)\{[\s\S]*?\}\('([\s\S]*?)',(\d+),(\d+),'([\s\S]*?)'\.split\('\|'\)/.exec(
    html
  );
  if (!call) return null;
  const words = call[4].split("|");
  const code = unpackPacked(call[1], words);
  const urls = {};
  // source='https://host/uuid/playlist.m3u8';source842='...'; — quotes are
  // escaped in the packed code (=\'…\'), so allow a backslash around them and
  // strip every backslash from the value.
  const assigns = code.match(/[A-Za-z0-9_$]+\s*=\s*\\?'[^']*\\?'/g) || [];
  for (const a of assigns) {
    const pair = /^([A-Za-z0-9_$]+)\s*=\s*\\?'([^']*)\\?'$/.exec(a);
    if (!pair) continue;
    const name = pair[1];
    const value = pair[2].replace(/\\/g, "");
    if (/^https:\/\/[a-z0-9.-]+\/[0-9a-fA-F-]+\/[^']+\.m3u8$/.test(value)) {
      urls[name] = value;
    }
  }
  const master = urls.source || null;
  if (!master) return null;
  const high = urls.source1280 || null;
  const low = urls.source842 || null;
  return { master: master, high: high, low: low };
}

// Candidate master URLs: the page's own host first (what the site's player
// uses), then the same {uuid}/playlist.m3u8 on the other known buckets.
function candidateMasters(master) {
  const cut = master.indexOf("://");
  const rest = master.slice(cut + 3); // host/uuid/playlist.m3u8
  const slash = rest.indexOf("/");
  const host = rest.slice(0, slash);
  const path = rest.slice(slash + 1);
  const out = [master];
  for (const h of STREAM_HOSTS) {
    if (h !== host) out.push("https://" + h + "/" + path);
  }
  return out;
}

// Read a verified master manifest into its direct variants (best first):
// [{ name: "1080p", url: ".../1080p/video.m3u8" }, ...]
function parseVariants(manifest, masterUrl) {
  const out = [];
  const base = masterUrl.slice(0, masterUrl.lastIndexOf("/") + 1);
  const lines = String(manifest).split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.indexOf("#EXT-X-STREAM-INF") !== 0) continue;
    const res = /RESOLUTION=(\d+)x(\d+)/.exec(line);
    let target = "";
    for (let j = i + 1; j < lines.length; j++) {
      const t = lines[j].trim();
      if (t && t.charAt(0) !== "#") {
        target = t;
        break;
      }
    }
    if (!target) continue;
    const url = /^https:\/\//.test(target) ? target : base + target;
    const height = res ? Number(res[2]) : 0;
    out.push({ height: height, name: height ? height + "p" : "video", url: url });
  }
  out.sort(function (a, b) {
    return b.height - a.height;
  });
  return out;
}

// One card of a list page. The slug is the stable id/ref: video pages answer
// on /{slug}, /dm{n}/{slug} and /en/{slug} alike.
function toItem(slug, title, duration, extra) {
  const item = {
    id: slug,
    ref: slug,
    title: clean(title || slug),
    kind: "movie",
    adult: true,
    poster: IMG + "/" + encodeURIComponent(slug) + "/cover-n.jpg",
  };
  const ms = timeToMs(duration);
  if (ms > 0) item.runtimeMinutes = Math.round(ms / 60000);
  if (extra && extra.overview) item.overview = extra.overview;
  return item;
}

// Parse the cards of a list/search page: cover slug, duration, title.
function parseCards(html) {
  const out = [];
  const seen = {};
  if (!html) return out;
  const blocks = html.split('class="thumbnail group"');
  for (let b = 1; b < blocks.length; b++) {
    const block = blocks[b];
    const cover = /fourhoi\.com\/([a-z0-9._-]+)\/cover-t\.jpg/.exec(block);
    if (!cover) continue;
    const slug = cover[1];
    if (seen[slug]) continue;
    const titleMatch =
      /class="text-secondary group-hover:text-primary"[^>]*>\s*([\s\S]*?)<\/a>/.exec(block) ||
      /alt="([^"]+)"/.exec(block);
    let title = titleMatch ? titleMatch[1] : slug;
    const durationMatch = /bg-gray-800[^"]*">\s*([0-9:]+)\s*</.exec(block);
    seen[slug] = true;
    out.push(toItem(slug, title, durationMatch ? durationMatch[1] : ""));
  }
  return out;
}

// Fetch one list page and parse its cards; null on any failure.
async function fetchListPage(path, page) {
  await null;
  let url = SITE + path;
  if (page && page > 1) url += "?page=" + page;
  const html = await fetchText(url);
  if (!html) return null;
  const items = parseCards(html);
  return items;
}

// Join several consecutive site pages into one answer (max 8 pages = 96
// items, the most Kino accepts per answer). next continues at the page after
// the last one fetched while every page came back full (12 cards).
async function joinPages(path, startPage, pageCount) {
  await null;
  const asks = [];
  for (let i = 0; i < pageCount; i++) {
    asks.push(fetchListPage(path, startPage + i).catch(function () {
      return null;
    }));
  }
  const answers = await Promise.all(asks);
  const seen = {};
  const items = [];
  let full = true;
  for (const answer of answers) {
    if (!answer || answer.length === 0) {
      full = false;
      continue;
    }
    if (answer.length < 12) full = false;
    for (const item of answer) {
      if (seen[item.id]) continue;
      seen[item.id] = true;
      items.push(item);
    }
  }
  const result = { items: items };
  if (full && items.length >= 12) result.next = String(startPage + pageCount);
  return result;
}

// ---- Home rows --------------------------------------------------------------

// Each row: the id (also the "Ver más" browse ref, ASCII only), the Spanish
// title, the site path (without ?page=) and whether the site paginates it.
const ROWS = [
  { id: "hoy", title: "Populares de hoy", path: "/en/today-hot", pages: true },
  { id: "nuevos", title: "Nuevos lanzamientos", path: "/en/release", pages: true },
  { id: "recientes", title: "Actualizados recientemente", path: "/en/new", pages: true },
  { id: "vistos", title: "Los más vistos", path: "/en/new?sort=monthly_views", pages: true },
  { id: "guardados", title: "Los más guardados", path: "/en/release?sort=saved", pages: true },
  { id: "sin-censura", title: "Sin censura", path: "/en/uncensored-leak", pages: true },
  { id: "fc2", title: "FC2", path: "/en/fc2", pages: true },
  { id: "subtitulados", title: "Subtitulado", path: "/en/chinese-subtitle", pages: true },
  { id: "g-grandes", title: "Grandes pechos", path: "/en/genres/%E5%B7%A8%E4%B9%B3", pages: true },
  { id: "g-casadas", title: "Casadas", path: "/en/genres/%E4%BA%BA%E5%A6%BB", pages: true },
  { id: "g-maduras", title: "Maduras", path: "/en/genres/%E7%86%9F%E5%A5%B3", pages: true },
  { id: "g-jovenes", title: "Jóvenes hermosas", path: "/en/genres/%E7%BE%8E%E5%B0%91%E5%A5%B3", pages: true },
  { id: "g-oral", title: "Oral", path: "/en/genres/%E5%8F%A3%E4%BA%A4", pages: true },
  { id: "g-vr", title: "VR", path: "/en/genres/VR", pages: true },
];

function rowById(ref) {
  for (const row of ROWS) {
    if (row.id === ref) return row;
  }
  return null;
}

// Video page metadata: title, poster, duration.
function parseVideoPage(html) {
  const out = {};
  if (!html) return out;
  const title = /property="og:title"\s+content="([^"]*)"/.exec(html) || /<title>([^<]*)<\/title>/.exec(html);
  if (title) out.title = clean(title[1]);
  const image = /property="og:image"\s+content="([^"]*)"/.exec(html);
  if (image) out.poster = clean(image[1]);
  const duration = /property="og:video:duration"\s+content="(\d+)"/.exec(html);
  if (duration) out.durationMs = Number(duration[1]) * 1000;
  return out;
}

// Cloudflare's bot-management cookie for the surrit domain. kino.fetch sends
// it from the plugin's jar (that is why the verification fetch answers 200),
// but the player and Kino's playback proxy do not share that jar and the
// surrit WAF answers 403 to requests without it. Read it so the stream and
// sign() can carry it. Null when the jar is empty or the API is missing.
function cfCookie(url) {
  try {
    if (typeof kino.cookies === "object" && kino.cookies && typeof kino.cookies.get === "function") {
      return (
        kino.cookies.get(url, "__cf_bm") ||
        kino.cookies.get("https://surrit.com/", "__cf_bm") ||
        kino.cookies.get("https://c.surrit.com/", "__cf_bm") ||
        null
      );
    }
  } catch (e) {}
  return null;
}

// Player headers for a stream: the CDN gate (Referer + real User-Agent) plus
// the bot-management cookie when the jar has one. Sending the page's cookies
// back as the stream's headers is Kino's own browser.capture pattern.
function playerHeaders(cookie) {
  const h = { "User-Agent": UA, "Referer": SITE + "/" };
  if (cookie) h["Cookie"] = "__cf_bm=" + cookie;
  return h;
}

// Verify candidate manifests in parallel and keep the first that answers
// "#EXTM3U" (status 200). Never throws; returns null when none works.
// IMPORTANT: KinoResponse.text() is SYNCHRONOUS in the app (it returns the
// body string, not a Promise), so this never chains .then() on it -- await
// works both here and under the Node harness. Every network call in the
// plugin uses await + try/catch, never .then(), for the same reason.
async function verifyMaster(url) {
  await null;
  try {
    const r = await kino.fetch(url, {
      headers: STREAM_HEADERS,
      redirect: "follow",
      timeoutMs: 8000,
    });
    if (!r.ok) {
      log("manifest status", r.status, url);
      return null;
    }
    const text = await r.text();
    if (String(text).slice(0, 16).indexOf("#EXTM3U") === 0) {
      return { url: url, manifest: String(text) };
    }
    log("manifest not m3u8", url);
    return null;
  } catch (e) {
    log("manifest failed", (e && (e.code || e.message)) || "error", url);
    return null;
  }
}

async function verifyMasters(candidates) {
  await null;
  const asks = candidates.map(function (url) {
    return verifyMaster(url).catch(function (e) {
      log("manifest failed", (e && (e.code || e.message)) || "error", url);
      return null;
    });
  });
  const answers = await Promise.all(asks);
  for (const answer of answers) {
    if (answer) return answer;
  }
  return null;
}

export async function home() {
  await null;
  const rows = [];
  const asks = ROWS.map(function (row) {
    return joinPages(row.path, 1, CARDS_PER_ROW).catch(function () {
      return null;
    });
  });
  const answers = await Promise.all(asks);
  for (let i = 0; i < ROWS.length; i++) {
    const answer = answers[i];
    if (!answer || answer.items.length === 0) {
      log("home row failed", ROWS[i].id);
      continue;
    }
    rows.push({
      id: ROWS[i].id,
      title: ROWS[i].title,
      ref: ROWS[i].id,
      genre: "peliculas",
      items: answer.items,
    });
  }
  return rows;
}

export async function browse(ref, cursor) {
  await null;
  const row = rowById(String(ref || ""));
  if (!row) throw kino.error("not_found", "esa fila no existe");
  const page = cursor ? Number(cursor) : 1;
  if (!Number.isInteger(page) || page < 1 || page > 10000) {
    throw kino.error("not_found", "página inválida");
  }
  const result = await joinPages(row.path, page, PAGES_PER_ANSWER);
  if (result.items.length === 0) {
    if (page === 1) throw kino.error("unavailable", "njavtv.com no respondió");
    throw kino.error("not_found", "no hay más resultados");
  }
  // today-hot and friends: when the site stops answering at the cursor page
  // the chain ends (joinPages only sets next while pages come back full).
  return { items: result.items.slice(0, 100), next: result.next };
}

export async function search(query) {
  await null;
  const q = query && typeof query.q === "string" ? query.q.trim() : "";
  if (!q) return [];
  const page = query.cursor ? Number(query.cursor) : 1;
  if (!Number.isInteger(page) || page < 1 || page > 10000) return [];
  const path = "/en/search/" + encodeURIComponent(q);
  const result = await joinPages(path, page, PAGES_PER_ANSWER);
  if (result.items.length === 0 && page === 1) return [];
  return result;
}

export async function resolve(ref) {
  await null;
  const slug = String(ref || "").trim();
  if (!/^[A-Za-z0-9._~-]{1,128}$/.test(slug)) {
    throw kino.error("not_found", "referencia inválida");
  }
  const html = await fetchText(SITE + "/en/" + encodeURIComponent(slug), 12000);
  if (!html) throw kino.error("unavailable", "no se pudo abrir el video");
  const sources = videoSources(html);
  if (!sources) {
    throw kino.error("not_found", "el video ya no está disponible en nJAV");
  }
  const meta = parseVideoPage(html);
  const verified = await verifyMasters(candidateMasters(sources.master));
  if (!verified) {
    throw kino.error("unavailable", "ningún servidor de video respondió");
  }
  const variants = parseVariants(verified.manifest, verified.url);
  const verifiedHost = /^https:\/\/[^/]+/.exec(verified.url)[0].slice(8);
  // The jar cookie that just made the verification fetch pass (read AFTER the
  // fetches, so a fresh install already has one). Every resolve refreshes it,
  // and expiresInSeconds makes Kino re-resolve before its ~30 min TTL ends.
  const cookie = cfCookie(verified.url);
  const stream = {
    url: verified.url,
    mime: "application/x-mpegURL",
    headers: playerHeaders(cookie),
    // Play every playlist and segment through Kino's local proxy with sign()
    // (exported below) re-attaching the CDN gate headers per request: the
    // surrit WAF answers 403 to any request without Referer + browser UA +
    // the Cloudflare cookie, and neither the player nor the proxy shares the
    // plugin's cookie jar.
    signing: "request",
    signContext: JSON.stringify({ cookie: cookie || "" }),
    expiresInSeconds: 1800,
    label: "Surrit · Auto",
  };
  if (meta.durationMs > 0) stream.durationMs = meta.durationMs;
  // Other buckets serving the same path: Kino moves the playlist (and any
  // failing segment) to them by itself while the stream is signed.
  const otherHosts = candidateMasters(sources.master)
    .map(function (u) {
      return /^https:\/\/([^/]+)/.exec(u)[1];
    })
    .filter(function (h, i, all) {
      return h !== verifiedHost && all.indexOf(h) === i;
    });
  if (otherHosts.length > 0) stream.alternateHosts = otherHosts.slice(0, 6);
  // Fallback copies for runtimes that ignore per-request signing (the app
  // also ignores these while the stream is signed).
  const alternatives = [];
  if (variants.length > 0) {
    alternatives.push({
      url: variants[0].url,
      label: "Surrit · " + variants[0].name,
    });
  }
  // The packer's direct variant (what the site's own fallback uses), when it
  // is not already the top variant we listed.
  if (sources.high) {
    const swapped = swapHost(sources.high, verified.url);
    const name = variantName(swapped, variants);
    if (!alternatives.some(function (a) {
      return a.url === swapped;
    })) {
      alternatives.push({ url: swapped, label: "Surrit · " + name });
    }
  }
  if (variants.length > 1) {
    const low = variants[variants.length - 1];
    if (!alternatives.some(function (a) {
      return a.url === low.url;
    })) {
      alternatives.push({ url: low.url, label: "Surrit · " + low.name });
    }
  }
  if (alternatives.length > 0) stream.alternatives = alternatives.slice(0, 8);
  return stream;
}

// Rebuild a packer URL on the host that verified.
function swapHost(url, verifiedUrl) {
  const verifiedHost = /^https:\/\/[^/]+/.exec(verifiedUrl)[0];
  const path = url.slice(/^https:\/\/[^/]+/.exec(url)[0].length);
  return verifiedHost + path;
}

// apiVersion 6, with the stream's signing: "request": headers for ONE player
// request. Kino calls this for the master playlist, every variant playlist
// and every segment (kind: "playlist" | "segment"), through its local proxy,
// and sends these headers merged over the stream's own. The surrit WAF
// (Cloudflare) refuses (403) any request without the site's Referer, a real
// User-Agent and the __cf_bm bot-management cookie, so every request must
// carry all three. The cookie travels in signContext (sign() can't read
// kino.cookies there); resolve() refreshes it on every call and
// expiresInSeconds (30 min, the cookie's own TTL) forces a re-resolve before
// it can go stale. Static otherwise: sign() runs in a restricted sandbox
// (no kino.fetch, no kino.storage, 1.5 s limit).
export async function sign(request) {
  await null;
  const headers = { "User-Agent": UA, "Referer": SITE + "/" };
  let cookie = "";
  try {
    const ctx =
      request && typeof request.context === "string"
        ? JSON.parse(request.context)
        : null;
    if (ctx && typeof ctx.cookie === "string") cookie = ctx.cookie;
  } catch (e) {}
  if (cookie) headers["Cookie"] = "__cf_bm=" + cookie;
  return { headers: headers };
}

// "720p" from a .../720p/video.m3u8 URL, falling back to the manifest's names.
function variantName(url, variants) {
  const m = /\/(\d+p)\/[^/]+\.m3u8$/.exec(url);
  if (m) return m[1];
  const hit = variants.filter(function (v) {
    return v.url === url;
  })[0];
  return hit ? hit.name : "video";
}
