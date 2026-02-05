import sdk from "stremio-addon-sdk";
import http from "http";
import { promises as fs } from "fs";
import path from "path";
import crypto from "crypto";
import { createRequire } from "module";

const BASE_URL = "https://v6.voiranime.com";
const PORT = Number(process.env.PORT || 8000);
const CACHE_DIR = process.env.CACHE_DIR || "/tmp/voiranime-stremio-cache";
const { addonBuilder } = sdk;
const require = createRequire(import.meta.url);
const express = require("express");
const getRouter = require("stremio-addon-sdk/src/getRouter");
const landingTemplate = require("stremio-addon-sdk/src/landingTemplate");

const manifest = {
  id: "com.voiranime.addon",
  version: "1.0.0",
  name: "Voiranime",
  description: "Addon Voiranime (catalogue, metadata, stream)",
  logo: "https://voiranime.com/wp-content/uploads/2019/12/vato.png",
  background: "https://voiranime.com/wp-content/uploads/2019/12/vato.png",
  resources: ["catalog", "meta", "stream"],
  types: ["series"],
  idPrefixes: ["voiranime"],
  catalogs: [
    {
      type: "series",
      id: "voiranime-ongoing",
      name: "Voiranime - En cours",
      extra: [{ name: "skip", isRequired: false }]
    },
    {
      type: "series",
      id: "voiranime-recent",
      name: "Voiranime - Nouveaux ajouts",
      extra: [{ name: "skip", isRequired: false }]
    },
    {
      type: "series",
      id: "voiranime-search",
      name: "Voiranime - Recherche",
      extra: [{ name: "search", isRequired: true }]
    }
  ]
};

const cache = new Map();
const CACHE_VERSION = "v2";
const stats = {
  startedAt: new Date().toISOString(),
  requests: { catalog: 0, meta: 0, stream: 0 },
  lastError: null
};
const CACHE_TTL_MS = 15 * 60 * 1000;
const PAGE_SIZE = 10;

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) {
    cache.delete(key);
    return null;
  }
  return hit.value;
}

function cacheSet(key, value, ttlMs = CACHE_TTL_MS) {
  cache.set(key, { value, expiresAt: Date.now() + ttlMs });
}

async function diskCacheGet(key) {
  try {
    const file = path.join(CACHE_DIR, cacheKeyToFile(key));
    const raw = await fs.readFile(file, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || !parsed.expiresAt || Date.now() > parsed.expiresAt) return null;
    return parsed.value;
  } catch {
    return null;
  }
}

async function diskCacheSet(key, value, ttlMs = CACHE_TTL_MS) {
  try {
    await fs.mkdir(CACHE_DIR, { recursive: true });
    const file = path.join(CACHE_DIR, cacheKeyToFile(key));
    const payload = { value, expiresAt: Date.now() + ttlMs };
    await fs.writeFile(file, JSON.stringify(payload), "utf8");
  } catch {
    // ignore disk cache errors
  }
}

function cacheKeyToFile(key) {
  return crypto.createHash("sha1").update(`${CACHE_VERSION}:${key}`).digest("hex") + ".json";
}

async function fetchHtml(url) {
  const memCached = cacheGet(url);
  if (memCached) return memCached;

  const diskCached = await diskCacheGet(url);
  if (diskCached) {
    cacheSet(url, diskCached);
    return diskCached;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "user-agent": "Mozilla/5.0 (Stremio Addon; +https://stremio.com)",
        "accept": "text/html,application/xhtml+xml"
      }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    const text = await res.text();
    cacheSet(url, text);
    await diskCacheSet(url, text);
    return text;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchJson(url) {
  const memCached = cacheGet(url);
  if (memCached) return memCached;

  const diskCached = await diskCacheGet(url);
  if (diskCached) {
    cacheSet(url, diskCached);
    return diskCached;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "user-agent": "Mozilla/5.0 (Stremio Addon)" }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    const json = await res.json();
    cacheSet(url, json);
    await diskCacheSet(url, json);
    return json;
  } finally {
    clearTimeout(timeout);
  }
}

function decodeHtml(str) {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&#8217;/g, "'")
    .replace(/&#8216;/g, "'")
    .replace(/&#8220;/g, '"')
    .replace(/&#8221;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function extractBetween(html, startRegex, endRegex) {
  const startMatch = startRegex.exec(html);
  if (!startMatch) return null;
  const startIndex = startMatch.index + startMatch[0].length;
  const rest = html.slice(startIndex);
  const endMatch = endRegex.exec(rest);
  if (!endMatch) return null;
  return rest.slice(0, endMatch.index);
}

function seriesIdFromSlug(slug) {
  return `voiranime:${slug}`;
}

function videoIdFromSlugs(seriesSlug, episodeSlug) {
  return `voiranime:${seriesSlug}:${episodeSlug}`;
}

function parseSlugFromAnimeUrl(url) {
  const match = url.match(/https?:\/\/v6\.voiranime\.com\/anime\/([^/]+)\/?$/);
  return match ? match[1] : null;
}

function parseEpisodeSlugFromUrl(url) {
  const match = url.match(/https?:\/\/v6\.voiranime\.com\/anime\/[^/]+\/([^/]+)\/?$/);
  return match ? match[1] : null;
}

const imdbToSlug = new Map();

function parseCatalogItems(html) {
  const items = [];
  const seen = new Set();
  const linkRegex = /<a href="(https:\/\/v6\.voiranime\.com\/anime\/[^/"]+\/)">([^<]*)<\/a>/g;

  let match;
  while ((match = linkRegex.exec(html))) {
    const url = match[1];
    const title = decodeHtml(match[2]);
    const slug = parseSlugFromAnimeUrl(url);
    if (!slug || seen.has(slug)) continue;

    const poster = extractPosterNearUrl(html, url);

    items.push({
      id: seriesIdFromSlug(slug),
      _slug: slug,
      type: "series",
      name: title,
      poster: poster || undefined
    });
    seen.add(slug);
  }

  return items;
}

function extractPosterNearUrl(html, url) {
  const idx = html.indexOf(url);
  if (idx === -1) return null;
  const start = Math.max(0, idx - 1200);
  const end = Math.min(html.length, idx + 400);
  const snippet = html.slice(start, end);
  const dataSrcMatch = snippet.match(/<img[^>]+data-src="([^"]+)"/i);
  if (dataSrcMatch) return dataSrcMatch[1];

  const srcMatch = snippet.match(/<img[^>]+src="([^"]+)"/i);
  if (srcMatch) return srcMatch[1];

  const srcsetMatch = snippet.match(/<img[^>]+srcset="([^"]+)"/i);
  if (srcsetMatch) {
    const first = srcsetMatch[1].split(",")[0].trim();
    const urlMatch = first.match(/^([^\s]+)/);
    return urlMatch ? urlMatch[1] : null;
  }

  return null;
}

function parseAnimeMeta(html, seriesSlug) {
  let title = seriesSlug;
  const h1Match = html.match(/<h1[^>]*>\s*([^<]+)\s*<\/h1>/i) || html.match(/post-title[^>]*>[\s\S]*?<h1[^>]*>([^<]+)<\/h1>/i);
  if (h1Match) title = decodeHtml(h1Match[1]);

  let poster = null;
  const ogImageMatch = html.match(/<meta property="og:image" content="([^"]+)"/i);
  if (ogImageMatch) poster = ogImageMatch[1];
  if (!poster) {
    const posterMatch = html.match(/<div class="summary_image"[\s\S]*?<img[^>]+src="([^"]+)"/i);
    if (posterMatch) poster = posterMatch[1];
  }

  let description = null;
  const ogDescMatch = html.match(/<meta property="og:description" content="([^"]+)"/i) || html.match(/<meta name="description" content="([^"]+)"/i);
  if (ogDescMatch) {
    description = decodeHtml(ogDescMatch[1]).trim();
    if (description.length > 800) description = description.slice(0, 797) + "...";
  }

  const genres = [];
  const genreTagRegex = /<a href="[^"]*anime-genre\/[^"]+"\s+rel="tag">([^<]+)<\/a>/g;
  let g;
  while ((g = genreTagRegex.exec(html))) {
    const name = decodeHtml(g[1]);
    if (!genres.includes(name)) genres.push(name);
  }

  const episodes = parseEpisodes(html, seriesSlug);

  return {
    id: seriesIdFromSlug(seriesSlug),
    type: "series",
    name: title,
    poster: poster || undefined,
    background: poster || undefined,
    description: description || undefined,
    genres: genres.length ? genres : undefined,
    videos: episodes
  };
}

function parseEpisodes(html, seriesSlug) {
  const episodes = [];
  const baseAnimePath = `${BASE_URL}/anime/${seriesSlug}/`;
  const liRegex = /<li class="wp-manga-chapter[\s\S]*?<\/li>/g;
  let m;
  while ((m = liRegex.exec(html))) {
    const block = m[0];
    const linkMatch = block.match(/<a href="(https:\/\/v6\.voiranime\.com\/anime\/[^/]+\/[^"]+)"[^>]*>([^<]*)<\/a>/i);
    if (!linkMatch) continue;

    const episodeUrl = linkMatch[1];
    const epText = decodeHtml(linkMatch[2]);
    const episodeSlug = parseEpisodeSlugFromUrl(episodeUrl);
    if (!episodeSlug) continue;

    const dateMatch = block.match(/post-on[^>]*>\s*([^<]+)\s*</i) || block.match(/<\/a>\s*([A-Za-z0-9\s,]+)\s*</i);
    const released = dateMatch ? decodeHtml(dateMatch[1]) : undefined;

    const episodeNumMatch = epText.match(/(\d+)/);
    const episode = episodeNumMatch ? Number(episodeNumMatch[1]) : undefined;

    episodes.push({
      id: videoIdFromSlugs(seriesSlug, episodeSlug),
      title: `Episode ${episode ?? epText}`,
      season: 1,
      episode: episode,
      released: released
    });
  }

  if (!episodes.length) {
    const linkRegex2 = new RegExp(`<a href="(${baseAnimePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^"]+)"[^>]*>([^<]*)</a>`, "g");
    let linkMatch;
    while ((linkMatch = linkRegex2.exec(html))) {
      const episodeUrl = linkMatch[1];
      const epText = decodeHtml(linkMatch[2]);
      const episodeSlug = parseEpisodeSlugFromUrl(episodeUrl);
      if (!episodeSlug) continue;
      const episodeNumMatch = epText.match(/(\d+)/);
      const episode = episodeNumMatch ? Number(episodeNumMatch[1]) : undefined;
      episodes.push({
        id: videoIdFromSlugs(seriesSlug, episodeSlug),
        title: `Episode ${episode ?? epText}`,
        season: 1,
        episode: episode,
        released: undefined
      });
    }
  }

  return episodes;
}

function extractStreamSources(html) {
  const sources = [];
  const objMatch = html.match(/var thisChapterSources = (\{[\s\S]*?\});/);

  if (objMatch) {
    try {
      const obj = JSON.parse(objMatch[1]);
      for (const [name, iframeHtml] of Object.entries(obj)) {
        const srcMatch = typeof iframeHtml === "string" && (iframeHtml.match(/src=\"([^\"]+)\"/i) || iframeHtml.match(/src="([^"]+)"/i));
        if (srcMatch) {
          const url = srcMatch[1].replace(/\\\//g, "/");
          sources.push({ name: decodeHtml(name), url });
        }
      }
    } catch {
      // ignore parse errors
    }
  }

  if (!sources.length) {
    const iframeMatch = html.match(/<iframe[^>]+src="([^"]+)"/i);
    if (iframeMatch) {
      sources.push({ name: "Lecteur", url: iframeMatch[1] });
    }
  }

  return sources;
}

function normalizeTitle(title) {
  return title
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

async function fetchCinemetaByTitle(title) {
  if (!title) return null;
  const url = `https://v3-cinemeta.strem.io/catalog/series/top/search=${encodeURIComponent(title)}.json`;
  try {
    const data = await fetchJson(url);
    if (!data || !Array.isArray(data.metas)) return null;
    const target = normalizeTitle(title);
    let best = null;
    for (const meta of data.metas) {
      if (!meta || !meta.name) continue;
      const cand = normalizeTitle(meta.name);
      if (cand === target) return meta;
      if (!best) best = meta;
    }
    return best;
  } catch {
    return null;
  }
}

async function fetchCinemetaByImdb(imdbId) {
  if (!imdbId) return null;
  const url = `https://v3-cinemeta.strem.io/meta/series/${encodeURIComponent(imdbId)}.json`;
  try {
    const data = await fetchJson(url);
    return data && data.meta ? data.meta : null;
  } catch {
    return null;
  }
}

async function searchVoiranimeByTitle(title) {
  if (!title) return null;
  const url = `${BASE_URL}/?s=${encodeURIComponent(title)}&post_type=wp-manga`;
  const html = await fetchHtml(url);
  const items = parseCatalogItems(html);
  const target = normalizeTitle(title);
  for (const item of items) {
    if (normalizeTitle(item.name) === target) return item;
  }
  return items[0] || null;
}

async function enrichMetasWithCinemeta(items) {
  for (const item of items) {
    const cinemeta = await fetchCinemetaByTitle(item.name);
    if (!cinemeta) continue;
    if (cinemeta.poster) item.poster = cinemeta.poster;
    if (cinemeta.background) item.background = cinemeta.background;
    if (cinemeta.imdb_id) item.imdb_id = cinemeta.imdb_id;
  }
}

function isVidmoly(url) {
  return /vidmoly\.(biz|me|to|net)/i.test(url);
}

function normalizeUrl(url) {
  return url
    .replace(/\\u0026/g, "&")
    .replace(/\\\\/g, "\\")
    .replace(/&amp;/g, "&")
    .replace(/\\\//g, "/")
    .trim();
}

function extractFirstPlayableUrl(html) {
  const patterns = [
    /file:\s*\"([^\"]+)\"/i,
    /file:\s*'([^']+)'/i,
    /\"file\"\s*:\s*\"([^\"]+)\"/i,
    /sources:\s*\[(?:.|\n|\r)*?\"file\"\s*:\s*\"([^\"]+)\"/i,
    /source\s+src=\"([^\"]+)\"/i
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match && match[1]) return normalizeUrl(match[1]);
  }

  return null;
}

async function resolveVidmoly(embedUrl) {
  try {
    const html = await fetchHtml(embedUrl);
    const direct = extractFirstPlayableUrl(html);
    return direct;
  } catch {
    return null;
  }
}

async function handleCatalog(search) {
  try {
    const url = search
      ? `${BASE_URL}/?s=${encodeURIComponent(search)}&post_type=wp-manga`
      : `${BASE_URL}/`;

    const html = await fetchHtml(url);
    const items = parseCatalogItems(html);
    await enrichMetasWithCinemeta(items);
    for (const item of items) delete item._slug;
    return { metas: items };
  } catch (err) {
    stats.lastError = {
      at: new Date().toISOString(),
      where: "catalog",
      message: err?.message || String(err)
    };
    return { metas: [] };
  }
}

async function handleCatalogPaged(search, skip, mode = "default") {
  try {
    if (search) return handleCatalog(search);
    const page = Math.floor((skip || 0) / PAGE_SIZE) + 1;
    let basePath;
    if (mode === "recent") {
      basePath = page > 1 ? `${BASE_URL}/nouveaux-ajouts/page/${page}/` : `${BASE_URL}/nouveaux-ajouts/`;
    } else {
      basePath = page > 1 ? `${BASE_URL}/page/${page}/` : `${BASE_URL}/`;
    }
    const url = mode === "recent" ? basePath : (page === 1 ? `${BASE_URL}/` : basePath);
    const html = await fetchHtml(url);
    const items = parseCatalogItems(html);
    await enrichMetasWithCinemeta(items);
    for (const item of items) delete item._slug;
    return { metas: items };
  } catch (err) {
    stats.lastError = {
      at: new Date().toISOString(),
      where: "catalogPaged",
      message: err?.message || String(err)
    };
    return { metas: [] };
  }
}

async function handleCatalogOngoing(skip) {
  try {
    const page = Math.floor((skip || 0) / PAGE_SIZE) + 1;
    const url = page > 1 ? `${BASE_URL}/page/${page}/` : `${BASE_URL}/?filter=all`;
    const html = await fetchHtml(url);
    const items = parseCatalogItems(html);
    await enrichMetasWithCinemeta(items);
    for (const item of items) delete item._slug;
    return { metas: items };
  } catch (err) {
    stats.lastError = {
      at: new Date().toISOString(),
      where: "catalogOngoing",
      message: err?.message || String(err)
    };
    return { metas: [] };
  }
}

async function handleMeta(seriesId) {
  let slug = null;
  let imdbId = null;

  const slugMatch = seriesId.match(/^voiranime:([^:]+)$/);
  if (slugMatch) {
    slug = slugMatch[1];
  } else if (/^tt\d+/.test(seriesId)) {
    imdbId = seriesId;
    slug = imdbToSlug.get(imdbId) || null;
    if (!slug) {
      const cinemeta = await fetchCinemetaByImdb(imdbId);
      if (cinemeta && cinemeta.name) {
        const item = await searchVoiranimeByTitle(cinemeta.name);
        if (item && item.id && item.id.startsWith("voiranime:")) {
          slug = item.id.split(":")[1];
          imdbToSlug.set(imdbId, slug);
        }
      }
    }
  }

  if (!slug) return { meta: null };

  try {
    const url = `${BASE_URL}/anime/${slug}/`;
    const html = await fetchHtml(url);
    const meta = parseAnimeMeta(html, slug);

    const cinemeta = imdbId
      ? await fetchCinemetaByImdb(imdbId)
      : await fetchCinemetaByTitle(meta.name);

    if (cinemeta) {
      if (cinemeta.poster) meta.poster = cinemeta.poster;
      if (cinemeta.background) meta.background = cinemeta.background;
      if (cinemeta.imdb_id) meta.imdb_id = cinemeta.imdb_id;
    }

    return { meta };
  } catch (err) {
    stats.lastError = {
      at: new Date().toISOString(),
      where: "meta",
      message: err?.message || String(err),
      id: seriesId
    };
    return { meta: null };
  }
}

async function handleStream(videoId) {
  try {
    const match = videoId.match(/^voiranime:([^:]+):([^:]+)$/);
    if (!match) return { streams: [] };

    const seriesSlug = match[1];
    const episodeSlug = match[2];
    const url = `${BASE_URL}/anime/${seriesSlug}/${episodeSlug}/`;
    const html = await fetchHtml(url);
    const sources = extractStreamSources(html);

    const streams = [];
    for (const s of sources) {
      if (isVidmoly(s.url)) {
        const direct = await resolveVidmoly(s.url);
        if (direct) {
          streams.push({
            title: `${s.name} (direct)`,
            url: direct
          });
          continue;
        }
      }
      streams.push({
        title: s.name,
        externalUrl: s.url
      });
    }

    if (!streams.length) {
      console.warn(`[stream] no sources found for ${videoId}, using episode page`);
      streams.push({
        title: "Voiranime (page épisode)",
        externalUrl: url
      });
    }

    return { streams };
  } catch (err) {
    stats.lastError = {
      at: new Date().toISOString(),
      where: "stream",
      message: err?.message || String(err),
      id: videoId
    };
    return { streams: [] };
  }
}

const builder = new addonBuilder(manifest);

builder.defineCatalogHandler(async ({ type, id, extra }) => {
  console.log(`[catalog] type=${type} id=${id} extra=${JSON.stringify(extra || {})}`);
  stats.requests.catalog += 1;
  if (type !== "series") return { metas: [] };

  if (id === "voiranime-ongoing") {
    const skip = Number(extra && extra.skip ? extra.skip : 0);
    const result = await handleCatalogOngoing(Number.isNaN(skip) ? 0 : skip);
    const first = result.metas && result.metas[0] ? result.metas[0].id : "none";
    console.log(`[catalog] first-id=${first}`);
    return result;
  }

  if (id === "voiranime-recent") {
    const skip = Number(extra && extra.skip ? extra.skip : 0);
    const result = await handleCatalogPaged(null, Number.isNaN(skip) ? 0 : skip, "recent");
    const first = result.metas && result.metas[0] ? result.metas[0].id : "none";
    console.log(`[catalog] first-id=${first}`);
    return result;
  }

  if (id === "voiranime-search") {
    const search = (extra && extra.search) || null;
    const result = await handleCatalog(search || "");
    const first = result.metas && result.metas[0] ? result.metas[0].id : "none";
    console.log(`[catalog] first-id=${first}`);
    return result;
  }

  return { metas: [] };
});

builder.defineMetaHandler(async ({ type, id }) => {
  console.log(`[meta] type=${type} id=${id}`);
  stats.requests.meta += 1;
  if (type !== "series") return { meta: null };
  return handleMeta(id);
});

builder.defineStreamHandler(async ({ type, id }) => {
  console.log(`[stream] type=${type} id=${id}`);
  stats.requests.stream += 1;
  if (type !== "series") return { streams: [] };
  return handleStream(id);
});

const addonInterface = builder.getInterface();
const app = express();
const hasConfig = !!(addonInterface.manifest.config || []).length;
const landingHTML = landingTemplate(addonInterface.manifest);

app.get("/stats.json", (_, res) => {
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(stats));
});

app.use(getRouter(addonInterface));

app.get("/", (_, res) => {
  if (hasConfig) {
    res.redirect("/configure");
  } else {
    res.setHeader("content-type", "text/html");
    res.end(landingHTML);
  }
});

if (hasConfig) {
  app.get("/configure", (_, res) => {
    res.setHeader("content-type", "text/html");
    res.end(landingHTML);
  });
}

http.createServer(app).listen(PORT, "0.0.0.0");
console.log(`Voiranime addon running at http://0.0.0.0:${PORT}/manifest.json`);
