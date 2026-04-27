const TORBOX_8SPINE_MODULE = `
const MODULE_ID = 'torbox-torznab';
const TORBOX_API_BASE = 'https://api.torbox.app/v1/api';
const AUDIO_EXTENSIONS = ['flac', 'wav', 'aiff', 'alac', 'ape', 'm4a', 'aac', 'mp3', 'ogg', 'opus'];

let runtimeConfig = {
  torboxApiKey: '',
  prowlarrTorznabUrl: '',
  prowlarrApiKey: '',
  jackettTorznabUrl: '',
  jackettApiKey: '',
  musicCategories: '3000',
  searchLimit: 20,
  torboxTimeoutMs: 90000,
  torboxPollIntervalMs: 2500,
  maxExistingTorrentScan: 250
};

function getConfig() {
  const globalConfig =
    (typeof globalThis !== 'undefined' &&
      globalThis.__EIGHTSPINE_MODULE_CONFIG__ &&
      globalThis.__EIGHTSPINE_MODULE_CONFIG__[MODULE_ID]) ||
    {};

  return {
    ...runtimeConfig,
    ...globalConfig
  };
}

function setConfig(nextConfig = {}) {
  runtimeConfig = {
    ...runtimeConfig,
    ...nextConfig
  };

  return runtimeConfig;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeText(value = '') {
  return String(value)
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[_./]+/g, ' ')
    .replace(/[()[\\]{}]/g, ' ')
    .replace(/\\s+/g, ' ')
    .trim();
}

function decodeXml(value = '') {
  return String(value)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}

function ensureTorboxApiKey() {
  const apiKey =
    getConfig().torboxApiKey ||
    (typeof globalThis !== 'undefined' ? globalThis.TORBOX_API_KEY : '');

  if (!apiKey) {
    throw new Error('TorBox API key is missing.');
  }

  return apiKey;
}

function ensureTorznabSourceConfig(source) {
  const config = getConfig();
  const url = config[source + 'TorznabUrl'];
  const apiKey = config[source + 'ApiKey'];

  if (!url) {
    throw new Error(source + ' Torznab URL is missing.');
  }

  return {
    url,
    apiKey
  };
}

async function torboxFetch(path, options = {}) {
  const apiKey = ensureTorboxApiKey();
  const response = await fetch(TORBOX_API_BASE + path, {
    ...options,
    headers: {
      Authorization: 'Bearer ' + apiKey,
      ...(options.headers || {})
    }
  });

  const payload = await response.json();
  if (!response.ok || payload.success === false) {
    throw new Error(payload.detail || payload.error || 'TorBox request failed.');
  }

  return payload.data;
}

async function torboxCreateTorrent(magnet, name) {
  const body = new FormData();
  body.append('magnet', magnet);
  body.append('name', name || '8spine request');
  body.append('seed', '3');
  body.append('allow_zip', 'false');
  body.append('as_queued', 'false');
  body.append('add_only_if_cached', 'false');

  return torboxFetch('/torrents/createtorrent', {
    method: 'POST',
    body
  });
}

function stripQuery(url = '') {
  return String(url).split('?')[0];
}

function appendParams(baseUrl, params) {
  const url = new URL(baseUrl);
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value));
    }
  });
  return url.toString();
}

function getField(xml, tagName) {
  const regex = new RegExp('<' + tagName + '[^>]*>([\\\\s\\\\S]*?)<\\\\/' + tagName + '>', 'i');
  const match = xml.match(regex);
  return match ? decodeXml(match[1].trim()) : '';
}

function getAttrValue(xml, attrName) {
  const regex = new RegExp(
    '<(?:torznab:attr|newznab:attr)[^>]*name="' +
      attrName.replace(/[.*+?^\\\${}()|[\\]\\\\]/g, '\\\\$&') +
      '"[^>]*value="([^"]*)"',
    'i'
  );
  const match = xml.match(regex);
  return match ? decodeXml(match[1].trim()) : '';
}

function getEnclosureUrl(xml) {
  const match = xml.match(/<enclosure[^>]*url="([^"]+)"/i);
  return match ? decodeXml(match[1].trim()) : '';
}

function getExtension(name = '') {
  const parts = String(name).toLowerCase().split('.');
  return parts.length > 1 ? parts.pop() : '';
}

function isAudioName(name = '') {
  return AUDIO_EXTENSIONS.includes(getExtension(name));
}

function parseSearchResultItem(itemXml, source) {
  const title = getField(itemXml, 'title');
  const guid = getField(itemXml, 'guid');
  const link = getField(itemXml, 'link');
  const comments = getField(itemXml, 'comments');
  const infoHash = getAttrValue(itemXml, 'infohash').toUpperCase();
  const magnetUrl = getAttrValue(itemXml, 'magneturl');
  const seeders = Number(getAttrValue(itemXml, 'seeders') || 0);
  const peers = Number(getAttrValue(itemXml, 'peers') || 0);
  const size = Number(getAttrValue(itemXml, 'size') || getField(itemXml, 'size') || 0);
  const enclosureUrl = getEnclosureUrl(itemXml);
  const category = getAttrValue(itemXml, 'category');

  const resolvedMagnet =
    magnetUrl ||
    (enclosureUrl.startsWith('magnet:') ? enclosureUrl : '') ||
    (link.startsWith('magnet:') ? link : '') ||
    (infoHash
      ? 'magnet:?xt=urn:btih:' + encodeURIComponent(infoHash) + '&dn=' + encodeURIComponent(title)
      : '');

  return {
    source,
    title,
    guid,
    link,
    comments,
    infoHash,
    magnetUrl: resolvedMagnet,
    seeders,
    peers,
    size,
    category
  };
}

function parseTorznabResults(xml, source) {
  const items = xml.match(/<item[\\s\\S]*?<\\/item>/gi) || [];
  return items.map((itemXml) => parseSearchResultItem(itemXml, source));
}

function buildTorznabSearchUrl(baseUrl, apiKey, query, limit, categories) {
  const url = appendParams(baseUrl, {
    apikey: apiKey || undefined,
    t: 'music',
    q: query,
    cat: categories || '3000',
    extended: 1,
    offset: 0,
    limit: limit
  });

  return url;
}

async function queryTorznabSource(source, query, limit) {
  const config = ensureTorznabSourceConfig(source);
  const url = buildTorznabSearchUrl(
    config.url,
    config.apiKey,
    query,
    limit,
    getConfig().musicCategories
  );

  const response = await fetch(url);
  const xml = await response.text();

  if (!response.ok) {
    throw new Error(source + ' search failed with HTTP ' + response.status + '.');
  }

  if (/code="100"|invalid api key|authorization denied|api key/i.test(xml)) {
    throw new Error(source + ' rejected the API request.');
  }

  return parseTorznabResults(xml, source);
}

function parseTitleGuess(rawTitle = '') {
  const clean = String(rawTitle)
    .replace(/\\.(flac|wav|aiff|alac|ape|m4a|aac|mp3|ogg|opus)$/i, '')
    .replace(/[._]/g, ' ')
    .trim();

  let artist = 'Unknown Artist';
  let title = clean;
  let album = '';

  const match = clean.match(/^(.*?)\\s+-\\s+(.*)$/);
  if (match) {
    artist = match[1].trim() || artist;
    title = match[2].trim() || title;
  }

  const albumMatch = title.match(/^(.*?)\\s+-\\s+(.*?)\\s+-\\s+(.*)$/);
  if (albumMatch) {
    artist = albumMatch[1].trim() || artist;
    album = albumMatch[2].trim();
    title = albumMatch[3].trim() || title;
  }

  return {
    artist,
    title,
    album
  };
}

function inferQualityFromTitle(name = '') {
  const lower = String(name).toLowerCase();
  if (
    lower.includes('flac') ||
    lower.includes('lossless') ||
    lower.includes('24bit') ||
    lower.includes('24-bit') ||
    lower.includes('16bit') ||
    lower.includes('16-bit')
  ) {
    return 'LOSSLESS';
  }

  return 'HIGH';
}

function scoreSearchResult(query, result) {
  const haystack = normalizeText([query, result.title].join(' '));
  const target = normalizeText(result.title);
  const normalizedQuery = normalizeText(query);
  const queryTokens = normalizedQuery.split(' ').filter(Boolean);

  let score = 0;
  if (target.includes(normalizedQuery)) {
    score += 120;
  }

  queryTokens.forEach((token) => {
    if (haystack.includes(token)) {
      score += 12;
    }
  });

  score += Math.min(result.seeders || 0, 200);
  score += result.size > 0 ? Math.min(Math.floor(result.size / 50000000), 25) : 0;
  score += inferQualityFromTitle(result.title) === 'LOSSLESS' ? 20 : 0;
  score += result.source === 'prowlarr' ? 5 : 0;

  if (!result.magnetUrl) {
    score -= 1000;
  }

  return score;
}

async function searchWithFallbacks(query, limit) {
  const errors = [];

  try {
    const prowlarrResults = await queryTorznabSource('prowlarr', query, limit);
    const filtered = prowlarrResults.filter((item) => item.magnetUrl);
    if (filtered.length > 0) {
      return filtered;
    }
  } catch (error) {
    errors.push('Prowlarr: ' + error.message);
  }

  try {
    const jackettResults = await queryTorznabSource('jackett', query, limit);
    const filtered = jackettResults.filter((item) => item.magnetUrl);
    if (filtered.length > 0) {
      return filtered;
    }
  } catch (error) {
    errors.push('Jackett: ' + error.message);
  }

  if (errors.length > 0) {
    throw new Error(errors.join(' | '));
  }

  return [];
}

async function findExistingTorrentByHash(infoHash) {
  if (!infoHash) {
    return null;
  }

  const torrents = await torboxFetch(
    '/torrents/mylist?limit=' + encodeURIComponent(getConfig().maxExistingTorrentScan) + '&bypass_cache=true'
  );

  const items = Array.isArray(torrents) ? torrents : torrents ? [torrents] : [];
  const wantedHash = String(infoHash).toUpperCase();

  for (const torrent of items) {
    const altHashes = Array.isArray(torrent.alternative_hashes) ? torrent.alternative_hashes : [];
    const candidates = [torrent.hash].concat(altHashes).filter(Boolean).map((value) => String(value).toUpperCase());
    if (candidates.includes(wantedHash)) {
      return torrent;
    }
  }

  return null;
}

function chooseBestAudioFile(files) {
  const audioFiles = (Array.isArray(files) ? files : []).filter(
    (file) =>
      isAudioName(file.name || file.short_name || '') ||
      String(file.mimetype || '').startsWith('audio/')
  );

  if (audioFiles.length === 0) {
    return null;
  }

  return audioFiles.sort((a, b) => {
    const qualityA = inferQualityFromTitle(a.name || a.short_name || '') === 'LOSSLESS' ? 1 : 0;
    const qualityB = inferQualityFromTitle(b.name || b.short_name || '') === 'LOSSLESS' ? 1 : 0;
    if (qualityA !== qualityB) {
      return qualityB - qualityA;
    }

    return (b.size || 0) - (a.size || 0);
  })[0];
}

async function waitForTorboxAudio(torrentId) {
  const startedAt = Date.now();
  const timeoutMs = Number(getConfig().torboxTimeoutMs) || 90000;
  const pollMs = Number(getConfig().torboxPollIntervalMs) || 2500;

  while (Date.now() - startedAt < timeoutMs) {
    const torrent = await torboxFetch(
      '/torrents/mylist?id=' +
        encodeURIComponent(torrentId) +
        '&bypass_cache=true'
    );

    const audioFile = chooseBestAudioFile(torrent.files);
    if (audioFile && (torrent.download_finished || torrent.cached || torrent.download_present)) {
      return {
        torrent,
        file: audioFile
      };
    }

    await sleep(pollMs);
  }

  throw new Error('Timed out waiting for TorBox to prepare the audio file.');
}

async function resolveTrackToTorbox(trackPayload) {
  const existing = await findExistingTorrentByHash(trackPayload.infoHash);
  if (existing) {
    const existingFile = chooseBestAudioFile(existing.files);
    if (existingFile) {
      return {
        torrentId: existing.id,
        fileId: existingFile.id,
        fileName: existingFile.name || existingFile.short_name || trackPayload.title
      };
    }
  }

  const created = await torboxCreateTorrent(trackPayload.magnetUrl, trackPayload.title);
  const ready = await waitForTorboxAudio(created.torrent_id);

  return {
    torrentId: ready.torrent.id,
    fileId: ready.file.id,
    fileName: ready.file.name || ready.file.short_name || trackPayload.title
  };
}

const TORBOX_MODULE = {
  id: MODULE_ID,
  name: 'TorBox + Prowlarr/Jackett',
  version: '0.2.0',
  labels: ['TORBOX', 'PROWLARR', 'JACKETT'],

  settings: [
    {
      key: 'torboxApiKey',
      type: 'password',
      label: 'TorBox API Key',
      placeholder: 'Paste your TorBox API key'
    },
    {
      key: 'prowlarrTorznabUrl',
      type: 'text',
      label: 'Prowlarr Torznab URL',
      placeholder: 'http://localhost:9696/1/api'
    },
    {
      key: 'prowlarrApiKey',
      type: 'password',
      label: 'Prowlarr API Key',
      placeholder: 'Paste your Prowlarr API key'
    },
    {
      key: 'jackettTorznabUrl',
      type: 'text',
      label: 'Jackett Torznab URL',
      placeholder: 'http://localhost:9117/api/v2.0/indexers/all/results/torznab/api'
    },
    {
      key: 'jackettApiKey',
      type: 'password',
      label: 'Jackett API Key',
      placeholder: 'Paste your Jackett API key'
    }
  ],

  setConfig,
  configure: setConfig,

  searchTracks: async (query, limit) => {
    const resolvedLimit = Number(limit || getConfig().searchLimit || 20);
    const results = await searchWithFallbacks(query, resolvedLimit);

    const tracks = results
      .map((result) => {
        const parsed = parseTitleGuess(result.title);
        return {
          id: JSON.stringify({
            source: result.source,
            title: result.title,
            magnetUrl: result.magnetUrl,
            infoHash: result.infoHash,
            seeders: result.seeders,
            size: result.size
          }),
          title: parsed.title,
          artist: parsed.artist,
          album: parsed.album || result.source,
          duration: 0,
          albumCover: '',
          _score: scoreSearchResult(query, result)
        };
      })
      .sort((a, b) => b._score - a._score)
      .slice(0, resolvedLimit)
      .map((track) => ({
        id: track.id,
        title: track.title,
        artist: track.artist,
        album: track.album,
        duration: track.duration,
        albumCover: track.albumCover
      }));

    return {
      tracks,
      total: tracks.length
    };
  },

  getTrackStreamUrl: async (trackId, quality) => {
    const payload = typeof trackId === 'string' ? JSON.parse(trackId) : trackId;
    const resolved = await resolveTrackToTorbox(payload);
    const apiKey = ensureTorboxApiKey();
    const streamUrl = await torboxFetch(
      '/torrents/requestdl?token=' +
        encodeURIComponent(apiKey) +
        '&torrent_id=' +
        encodeURIComponent(resolved.torrentId) +
        '&file_id=' +
        encodeURIComponent(resolved.fileId) +
        '&redirect=false&append_name=true'
    );

    return {
      streamUrl,
      track: {
        id: trackId,
        audioQuality: quality === 'LOSSLESS' ? 'LOSSLESS' : inferQualityFromTitle(resolved.fileName)
      }
    };
  }
};

return TORBOX_MODULE;
`;

export const MODULE = TORBOX_8SPINE_MODULE;
