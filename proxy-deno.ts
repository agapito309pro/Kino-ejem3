/**
 * nJAV / surrit HLS Proxy — Deno Deploy
 *
 * surrit.com is on Cloudflare. TV players often drop Referer/Cookie → 403.
 * This proxy injects UA + Referer + optional __cf_bm and rewrites every m3u8
 * so segments also go through Deno (works on phone and Android TV).
 *
 * Deploy once (free):
 *   1) https://dash.deno.com  → Sign in with GitHub
 *   2) New Playground → paste this whole file → Deploy / Save & Deploy
 *   3) Copy https://xxxxx.deno.dev
 *   4) Kino → Plugins → nJAV → Ajustes → "Proxy HLS (Android TV)" → paste URL
 *
 * Prefer Deno over Cloudflare Workers: CF→CF to surrit is frequently 403.
 */

const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const DEFAULT_REFERER = "https://njavtv.com/";
const DEFAULT_ORIGIN = "https://njavtv.com";
const REFERER_REQUIRED_HOSTS = [
  "surrit.com",
  "sixyik.com",
  "nineyu.com",
  "fourhoi.com",
];
// Default referer is njavtv.com; override with ?ref= / ?orig= from the plugin.

function cors(h = {}) {
  const headers = new Headers(h);
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "*");
  headers.set(
    "Access-Control-Expose-Headers",
    "Content-Length, Content-Range, Content-Type, Accept-Ranges",
  );
  return headers;
}

function upstreamHeaders(targetUrl, refParam, origParam, rangeHeader, cookieParam) {
  const headers = new Headers();
  headers.set("User-Agent", DEFAULT_USER_AGENT);
  headers.set("Accept", "*/*");
  headers.set("Accept-Language", "en-US,en;q=0.9");
  if (rangeHeader) headers.set("Range", rangeHeader);

  let ref = "";
  let orig = "";
  if (refParam) {
    try {
      const u = new URL(refParam);
      if (u.protocol === "http:" || u.protocol === "https:") {
        ref = u.toString();
        orig = u.origin;
      }
    } catch {}
  }
  if (!ref) {
    const host = targetUrl.hostname.toLowerCase();
    if (REFERER_REQUIRED_HOSTS.some((s) => host === s || host.endsWith("." + s))) {
      ref = DEFAULT_REFERER;
      orig = DEFAULT_ORIGIN;
    }
  }
  if (origParam) {
    try {
      const u = new URL(origParam);
      if (u.protocol === "http:" || u.protocol === "https:") orig = u.origin;
    } catch {}
  }
  if (ref) headers.set("Referer", ref);
  if (orig) headers.set("Origin", orig);
  if (cookieParam) {
    try {
      const c = decodeURIComponent(cookieParam);
      if (c && c.length < 8000) headers.set("Cookie", c);
    } catch {}
  }
  return headers;
}

function buildProxyUrl(origin, target, kind, ref, orig, ck) {
  let path = "/seg.bin";
  if (kind === "m3u8") path = "/playlist.m3u8";
  else if (kind === "init") path = "/init.mp4";
  else if (kind === "mp4") path = "/seg.mp4";
  else if (kind === "ts") path = "/seg.ts";
  else if (kind === "key") path = "/key.bin";
  const u = new URL(origin + path);
  u.searchParams.set("url", target);
  if (ref) u.searchParams.set("ref", ref);
  if (orig) u.searchParams.set("orig", orig);
  if (ck) u.searchParams.set("ck", ck);
  return u.toString();
}

function rewriteM3u8(text, baseUrl, proxyOrigin, ref, orig, ck) {
  const base = new URL(baseUrl);
  const lines = text.split(/\r?\n/);
  const out = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      // Rewrite URI="..." inside tags (KEY, MAP, MEDIA)
      if (/URI="[^"]+"/.test(trimmed)) {
        out.push(
          trimmed.replace(/URI="([^"]+)"/g, (_m, uri) => {
            try {
              const abs = new URL(uri, base).toString();
              let kind = "key";
              if (/\.m3u8/i.test(abs)) kind = "m3u8";
              else if (/\.mp4|init/i.test(abs)) kind = "init";
              return `URI="${buildProxyUrl(proxyOrigin, abs, kind, ref, orig, ck)}"`;
            } catch {
              return _m;
            }
          }),
        );
      } else {
        out.push(line);
      }
      continue;
    }
    try {
      const abs = new URL(trimmed, base).toString();
      let kind = "ts";
      if (/\.m3u8/i.test(abs)) kind = "m3u8";
      else if (/\.mp4/i.test(abs)) kind = "mp4";
      else if (/\.m4s/i.test(abs)) kind = "mp4";
      out.push(buildProxyUrl(proxyOrigin, abs, kind, ref, orig, ck));
    } catch {
      out.push(line);
    }
  }
  return out.join("\n");
}

async function handler(request) {
  const reqUrl = new URL(request.url);

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors() });
  }

  if (reqUrl.pathname === "/" || reqUrl.pathname === "/health") {
    return new Response(
      JSON.stringify({
        ok: true,
        service: "njav-hls-proxy",
        usage: "/playlist.m3u8?url=<m3u8>&ref=<referer>&orig=<origin>&ck=<cookie>",
      }),
      { status: 200, headers: cors({ "Content-Type": "application/json; charset=utf-8" }) },
    );
  }

  const targetParam = reqUrl.searchParams.get("url") || reqUrl.searchParams.get("u");
  const refParam = reqUrl.searchParams.get("ref") || "";
  const origParam = reqUrl.searchParams.get("orig") || "";
  const cookieParam = reqUrl.searchParams.get("ck") || "";

  if (!targetParam) {
    return new Response(
      JSON.stringify({ error: "missing_url", hint: "?url=https://c.surrit.com/.../playlist.m3u8" }),
      { status: 400, headers: cors({ "Content-Type": "application/json; charset=utf-8" }) },
    );
  }

  let targetUrl;
  try {
    targetUrl = new URL(targetParam);
    if (targetUrl.protocol !== "http:" && targetUrl.protocol !== "https:") throw new Error("bad proto");
  } catch {
    return new Response("URL inválida", { status: 400, headers: cors() });
  }

  const fwd = upstreamHeaders(
    targetUrl,
    refParam,
    origParam,
    request.headers.get("Range"),
    cookieParam,
  );

  try {
    const upstream = await fetch(targetUrl.toString(), {
      method: request.method === "HEAD" ? "HEAD" : "GET",
      headers: fwd,
      redirect: "follow",
    });

    const outHeaders = cors(upstream.headers);
    const pathLower = targetUrl.pathname.toLowerCase();
    const reqPath = reqUrl.pathname.toLowerCase();
    const ct = (upstream.headers.get("content-type") || "").toLowerCase();

    const looksM3u8 =
      reqPath.endsWith(".m3u8") ||
      pathLower.endsWith(".m3u8") ||
      pathLower.endsWith(".m3u") ||
      ct.includes("mpegurl") ||
      ct.includes("m3u8");

    if (looksM3u8 && upstream.ok && request.method !== "HEAD") {
      const text = await upstream.text();
      if (text.trimStart().startsWith("#EXTM3U") || text.includes("#EXT")) {
        const rewritten = rewriteM3u8(
          text,
          targetUrl.toString(),
          reqUrl.origin,
          refParam,
          origParam,
          cookieParam,
        );
        outHeaders.set("Content-Type", "application/vnd.apple.mpegurl; charset=utf-8");
        outHeaders.delete("content-length");
        return new Response(rewritten, { status: 200, headers: outHeaders });
      }
    }

    if (reqPath.endsWith(".ts") || pathLower.endsWith(".ts")) {
      outHeaders.set("Content-Type", "video/mp2t");
    } else if (reqPath.endsWith(".mp4") || pathLower.endsWith(".mp4") || pathLower.endsWith(".m4s")) {
      outHeaders.set("Content-Type", "video/mp4");
    } else if (reqPath.endsWith(".m3u8") || pathLower.endsWith(".m3u8")) {
      outHeaders.set("Content-Type", "application/vnd.apple.mpegurl; charset=utf-8");
    }

    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: outHeaders,
    });
  } catch (e) {
    return new Response(
      JSON.stringify({ error: "proxy_failed", message: String(e && e.message || e) }),
      { status: 502, headers: cors({ "Content-Type": "application/json" }) },
    );
  }
}

Deno.serve(handler);
