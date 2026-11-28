// nJAV Kino plugin — Hotaru Yume / hotaruyume
// v1.0.4: optional hlsProxy (Deno Deploy) for Android TV / surrit WAF

const UA =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36";
const SITE = "https://njavtv.com";
const IMG = "https://fourhoi.com";

const PAGE_HEADERS = {
  "User-Agent": UA,
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

const STREAM_HEADERS = {
  "User-Agent": UA,
  "Referer": SITE + "/",
};

const STREAM_HOSTS = ["c.surrit.com", "surrit.com", "b.surrit.com"];

function hlsProxyBase() {
  try {
    const raw = String(kino.config.get("hlsProxy") || "").trim().replace(/\/+$/, "");
    if (!raw) return "";
    if (!/^https?:\/\//i.test(raw)) return "";
    const u = new URL(raw);
    if (u.protocol !== "https:" && u.protocol !== "http:") return "";
    return u.origin;
  } catch (e) {
    return "";
  }
}

function extractCookieFromHeaders(headers) {
  if (!headers) return "";
  if (typeof headers === "object" && !Array.isArray(headers)) {
    const c = headers.Cookie || headers.cookie || "";
    if (typeof c === "string" && c) {
      const m = /__cf_bm=([^;]+)/.exec(c);
      return m ? m[1] : c;
    }
  }
  return "";
}

function maybeProxyUrl(directUrl, pageUrl, cookie) {
  const worker = hlsProxyBase();
  if (!worker || !directUrl) return directUrl;
  if (String(directUrl).indexOf(worker) === 0) return directUrl;
  const low = String(directUrl).toLowerCase();
  const isCdn =
    /\.(m3u8|m3u)(\?|$)/i.test(low) ||
    /(surrit|sixyik|nineyu|fourhoi)\.com/i.test(low);
  if (!isCdn) return directUrl;
  const ref = pageUrl || SITE + "/";
  let orig = SITE;
  try {
    orig = new URL(ref).origin;
  } catch (e) {}
  const u = new URL(worker + "/playlist.m3u8");
  u.searchParams.set("url", directUrl);
  u.searchParams.set("ref", ref);
  u.searchParams.set("orig", orig);
  if (cookie) {
    try {
      u.searchParams.set("ck", cookie);
    } catch (e) {}
  }
  return u.toString();
}

function proxyStream(stream, pageUrl) {
  if (!stream || !stream.url) return stream;
  const worker = hlsProxyBase();
  if (!worker) {
    log("proxy OFF (hlsProxy vacío — en TV configura Deno Deploy en Ajustes)");
    return stream;
  }
  const cookie =
    extractCookieFromHeaders(stream.headers) ||
    (stream.signContext
      ? (function () {
          try {
            const ctx = JSON.parse(stream.signContext);
            return (ctx && ctx.cookie) || "";
          } catch (e) {
            return "";
          }
        })()
      : "");
  const page = pageUrl || SITE + "/";
  const proxied = maybeProxyUrl(stream.url, page, cookie);
  if (proxied === stream.url) {
    log("proxy: URL no es CDN, se deja directa", String(stream.url).slice(0, 80));
    return stream;
  }
  log("proxy ON", proxied.slice(0, 120), "cookie?", !!cookie);
  const out = {
    url: proxied,
    mime: stream.mime || "application/x-mpegURL",
    label: stream.label ? stream.label + " · proxy" : "Surrit · proxy",
  };
  if (stream.durationMs > 0) out.durationMs = stream.durationMs;
  out.headers = {
    "User-Agent": UA,
    Accept: "*/*",
  };
  if (Array.isArray(stream.alternatives) && stream.alternatives.length) {
    out.alternatives = stream.alternatives.map(function (a) {
      if (!a || !a.url) return a;
      return {
        url: maybeProxyUrl(a.url, page, cookie),
        label: a.label ? a.label + " · proxy" : "alt · proxy",
        mime: a.mime || "application/x-mpegURL",
        headers: out.headers,
      };
    });
  }
  return out;
}

const PAGES_PER_ANSWER = 8;
const CARDS_PER_ROW = 2;

function log() {
  try {
    kino.log.apply(null, arguments);
  } catch (e) {}
}

function decodeEntities(text) {
  return String(text)
    .replace(/&/g, "&")
    .replace(/"/g, '"')
    .replace(/&#0?39;|'|&#x0?27;/gi, "'")
    .replace(/</g, "<")
    .replace(/>/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&hellip;/gi, "…");
}

function clean(text) {
  return decodeEntities(String(text).replace(/\s+/g, " ")).trim();
}

function timeToMs(text) {
  const parts = String(text || "").trim().split(":");
  if (!parts.every((p) => /^\d+$/.test(p))) return 0;
  let seconds = 0;
  for (const p of parts) seconds = seconds * 60 + Number(p);
  return seconds > 0 ? seconds * 1000 : 0;
}

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

function unpackPacked(packed, words) {
  let text = packed;
  for (let c = words.length - 1; c >= 0; c--) {
    const word = words[c];
    if (!word) continue;
    const token = c.toString(36);
    const pattern = new RegExp("\\b" + token + "\\b", "g");
    text = text.replace(pattern, function () {
      return word;
    });
  }
  return text;
}

function videoSources(html) {
  if (!html) return null;
  const call = /eval\(function\(p,a,c,k,e,d\)\{[\s\S]*?\}\('([\s\S]*?)',(\d+),(\d+),'([\s\S]*?)'\.split\('\|'\)/.exec(
    html
  );
  if (!call) return null;
  const words = call[4].split("|");
  const code = unpackPacked(call[1], words);
  const urls = {};
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
  return { master: master, high: urls.source1280 || null, low: urls.source842 || null };
}

function candidateMasters(master) {
  const cut = master.indexOf("://");
  const rest = master.slice(cut + 3);
  const slash = rest.indexOf("/");
  const host = rest.slice(0, slash);
  const path = rest.slice(slash + 1);
  const out = [master];
  for (const h of STREAM_HOSTS) {
    if (h !== host) out.push("https://" + h + "/" + path);
  }
  return out;
}

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

async function fetchListPage(path, page) {
  await null;
  let url = SITE + path;
  if (page && page > 1) url += "?page=" + page;
  const html = await fetchText(url);
  if (!html) return null;
  return parseCards(html);
}

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

function playerHeaders(cookie) {
  const h = { "User-Agent": UA, "Referer": SITE + "/" };
  if (cookie) h["Cookie"] = "__cf_bm=" + cookie;
  return h;
}

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
  const cookie = cfCookie(verified.url);
  const stream = {
    url: verified.url,
    mime: "application/x-mpegURL",
    headers: playerHeaders(cookie),
    signing: "request",
    signContext: JSON.stringify({ cookie: cookie || "" }),
    expiresInSeconds: 1800,
    label: "Surrit · Auto",
  };
  if (meta.durationMs > 0) stream.durationMs = meta.durationMs;
  const otherHosts = candidateMasters(sources.master)
    .map(function (u) {
      return /^https:\/\/([^/]+)/.exec(u)[1];
    })
    .filter(function (h, i, all) {
      return h !== verifiedHost && all.indexOf(h) === i;
    });
  if (otherHosts.length > 0) stream.alternateHosts = otherHosts.slice(0, 6);
  const alternatives = [];
  if (variants.length > 0) {
    alternatives.push({
      url: variants[0].url,
      label: "Surrit · " + variants[0].name,
    });
  }
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
  if (hlsProxyBase()) {
    return proxyStream(stream, SITE + "/");
  }
  return stream;
}

function swapHost(url, verifiedUrl) {
  const verifiedHost = /^https:\/\/[^/]+/.exec(verifiedUrl)[0];
  const path = url.slice(/^https:\/\/[^/]+/.exec(url)[0].length);
  return verifiedHost + path;
}

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

function variantName(url, variants) {
  const m = /\/(\d+p)\/[^/]+\.m3u8$/.exec(url);
  if (m) return m[1];
  const hit = variants.filter(function (v) {
    return v.url === url;
  })[0];
  return hit ? hit.name : "video";
}
