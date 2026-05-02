const MODULE_ID = 'torbox-torznab';
const TORBOX_API_BASE = 'https://api.torbox.app/v1/api';
const TORBOX_LOGO = 'https://avatars.githubusercontent.com/u/144096078?s=280&v=4';
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
  var globalConfig =
    (typeof globalThis !== 'undefined' &&
      globalThis.__EIGHTSPINE_MODULE_CONFIG__ &&
      globalThis.__EIGHTSPINE_MODULE_CONFIG__[MODULE_ID]) ||
    {};
  return Object.assign({}, runtimeConfig, globalConfig);
}

function setConfig(nextConfig) {
  runtimeConfig = Object.assign({}, runtimeConfig, nextConfig || {});
  return runtimeConfig;
}

function getKey(context) {
  // Try module-level setting first, then global debrid key
  var setting = context && context.settings && context.settings.torboxApiKey;
  var fromSetting = setting && typeof setting === 'object' ? setting.value : setting;
  if (fromSetting && fromSetting.trim()) return fromSetting.trim();
  if (context && context.debridApiKey) return context.debridApiKey;
  var cfg = getConfig();
  return cfg.torboxApiKey || '';
}

function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[_./]+/g, ' ')
    .replace(/[()[\]{}]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function decodeXml(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}

// ============================================================================
// TORBOX ACCOUNT VERIFICATION
// ============================================================================

async function verifyTorBoxKey(apiKey) {
  try {
    var response = await fetch(TORBOX_API_BASE + '/user/me', {
      method: 'GET',
      headers: {
        'Authorization': 'Bearer ' + apiKey,
        'Content-Type': 'application/json'
      }
    });

    var data = await response.json();

    if (!response.ok || !data.success) {
      return { success: false, error: data.detail || 'Invalid API key' };
    }

    var userData = data.data || data;
    var planMap = { 0: 'Free', 1: 'Essential', 2: 'Pro', 3: 'Standard' };

    return {
      success: true,
      accountName: userData.email || userData.username || 'TorBox User',
      plan: planMap[userData.plan] || ('Plan ' + userData.plan),
      expiry: userData.premium_expires_at
        ? new Date(userData.premium_expires_at).toLocaleDateString()
        : 'Never'
    };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// ============================================================================
// TORBOX API HELPERS
// ============================================================================

async function torboxFetch(path, options, apiKey) {
  var opts = options || {};
  var response = await fetch(TORBOX_API_BASE + path, {
    method: opts.method || 'GET',
    body: opts.body || undefined,
    headers: Object.assign({ 'Authorization': 'Bearer ' + apiKey }, opts.headers || {})
  });
  var payload = await response.json();
  if (!response.ok || payload.success === false) {
    throw new Error(payload.detail || payload.error || 'TorBox request failed.');
  }
  return payload.data;
}

async function torboxCreateTorrent(magnet, name, apiKey) {
  var body = new FormData();
  body.append('magnet', magnet);
  body.append('name', name || '8spine request');
  body.append('seed', '3');
  body.append('allow_zip', 'false');
  body.append('as_queued', 'false');
  body.append('add_only_if_cached', 'false');
  return torboxFetch('/torrents/createtorrent', { method: 'POST', body: body }, apiKey);
}

// ============================================================================
// TORZNAB SEARCH (PROWLARR / JACKETT)
// ============================================================================

function appendParams(baseUrl, params) {
  var url = new URL(baseUrl);
  Object.entries(params).forEach(function (entry) {
    if (entry[1] !== undefined && entry[1] !== null && entry[1] !== '') {
      url.searchParams.set(entry[0], String(entry[1]));
    }
  });
  return url.toString();
}

function getField(xml, tagName) {
  var regex = new RegExp('<' + tagName + '[^>]*>([\\s\\S]*?)<\\/' + tagName + '>', 'i');
  var match = xml.match(regex);
  return match ? decodeXml(match[1].trim()) : '';
}

function getAttrValue(xml, attrName) {
  var escaped = attrName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  var regex = new RegExp('<(?:torznab:attr|newznab:attr)[^>]*name="' + escaped + '"[^>]*value="([^"]*)"', 'i');
  var match = xml.match(regex);
  return match ? decodeXml(match[1].trim()) : '';
}

function getEnclosureUrl(xml) {
  var match = xml.match(/<enclosure[^>]*url="([^"]+)"/i);
  return match ? decodeXml(match[1].trim()) : '';
}

function getExtension(name) {
  var parts = String(name || '').toLowerCase().split('.');
  return parts.length > 1 ? parts.pop() : '';
}

function isAudioName(name) {
  return AUDIO_EXTENSIONS.includes(getExtension(name));
}

function parseSearchResultItem(itemXml, source) {
  var title = getField(itemXml, 'title');
  var link = getField(itemXml, 'link');
  var infoHash = getAttrValue(itemXml, 'infohash').toUpperCase();
  var magnetUrl = getAttrValue(itemXml, 'magneturl');
  var seeders = Number(getAttrValue(itemXml, 'seeders') || 0);
  var size = Number(getAttrValue(itemXml, 'size') || getField(itemXml, 'size') || 0);
  var enclosureUrl = getEnclosureUrl(itemXml);

  var resolvedMagnet =
    magnetUrl ||
    (enclosureUrl.startsWith('magnet:') ? enclosureUrl : '') ||
    (link.startsWith('magnet:') ? link : '') ||
    (infoHash ? 'magnet:?xt=urn:btih:' + encodeURIComponent(infoHash) + '&dn=' + encodeURIComponent(title) : '');

  return { source: source, title: title, link: link, infoHash: infoHash, magnetUrl: resolvedMagnet, seeders: seeders, size: size };
}

function parseTorznabResults(xml, source) {
  var items = xml.match(/<item[\s\S]*?<\/item>/gi) || [];
  return items.map(function (itemXml) { return parseSearchResultItem(itemXml, source); });
}

async function queryTorznabSource(source, query, limit, context) {
  var cfg = getConfig();

  // Allow context settings to override config
  var url, apiKey;
  if (source === 'prowlarr') {
    var prowlarrSetting = context && context.settings && context.settings.prowlarrTorznabUrl;
    url = (prowlarrSetting && typeof prowlarrSetting === 'object' ? prowlarrSetting.value : prowlarrSetting) || cfg.prowlarrTorznabUrl;
    var prowlarrKeySetting = context && context.settings && context.settings.prowlarrApiKey;
    apiKey = (prowlarrKeySetting && typeof prowlarrKeySetting === 'object' ? prowlarrKeySetting.value : prowlarrKeySetting) || cfg.prowlarrApiKey;
  } else {
    var jackettSetting = context && context.settings && context.settings.jackettTorznabUrl;
    url = (jackettSetting && typeof jackettSetting === 'object' ? jackettSetting.value : jackettSetting) || cfg.jackettTorznabUrl;
    var jackettKeySetting = context && context.settings && context.settings.jackettApiKey;
    apiKey = (jackettKeySetting && typeof jackettKeySetting === 'object' ? jackettKeySetting.value : jackettKeySetting) || cfg.jackettApiKey;
  }

  if (!url) throw new Error(source + ' URL is not configured.');

  var searchUrl = appendParams(url, {
    apikey: apiKey || undefined,
    t: 'music',
    q: query,
    cat: cfg.musicCategories || '3000',
    extended: 1,
    offset: 0,
    limit: limit
  });

  var response = await fetch(searchUrl);
  var xml = await response.text();
  if (!response.ok) throw new Error(source + ' search failed with HTTP ' + response.status + '.');
  if (/code="100"|invalid api key|authorization denied/i.test(xml)) throw new Error(source + ' rejected the API key.');
  return parseTorznabResults(xml, source);
}

function parseTitleGuess(rawTitle) {
  var clean = String(rawTitle || '')
    .replace(/\.(flac|wav|aiff|alac|ape|m4a|aac|mp3|ogg|opus)$/i, '')
    .replace(/[._]/g, ' ')
    .trim();
  var artist = 'Unknown Artist';
  var title = clean;
  var album = '';
  var match = clean.match(/^(.*?)\s+-\s+(.*)$/);
  if (match) { artist = match[1].trim() || artist; title = match[2].trim() || title; }
  var albumMatch = title.match(/^(.*?)\s+-\s+(.*?)\s+-\s+(.*)$/);
  if (albumMatch) { artist = albumMatch[1].trim() || artist; album = albumMatch[2].trim(); title = albumMatch[3].trim() || title; }
  return { artist: artist, title: title, album: album };
}

function inferQualityFromTitle(name) {
  var lower = String(name || '').toLowerCase();
  if (lower.includes('flac') || lower.includes('lossless') || lower.includes('24bit') || lower.includes('16bit')) return 'LOSSLESS';
  return 'HIGH';
}

function scoreSearchResult(query, result) {
  var target = normalizeText(result.title);
  var normalizedQuery = normalizeText(query);
  var queryTokens = normalizedQuery.split(' ').filter(Boolean);
  var score = 0;
  if (target.includes(normalizedQuery)) score += 120;
  queryTokens.forEach(function (token) { if (target.includes(token)) score += 12; });
  score += Math.min(result.seeders || 0, 200);
  score += result.size > 0 ? Math.min(Math.floor(result.size / 50000000), 25) : 0;
  score += inferQualityFromTitle(result.title) === 'LOSSLESS' ? 20 : 0;
  score += result.source === 'prowlarr' ? 5 : 0;
  if (!result.magnetUrl) score -= 1000;
  return score;
}

async function searchWithFallbacks(query, limit, context) {
  var errors = [];
  try {
    var prowlarrResults = await queryTorznabSource('prowlarr', query, limit, context);
    var filtered = prowlarrResults.filter(function (i) { return i.magnetUrl; });
    if (filtered.length > 0) return filtered;
  } catch (e) { errors.push('Prowlarr: ' + e.message); }
  try {
    var jackettResults = await queryTorznabSource('jackett', query, limit, context);
    var filtered2 = jackettResults.filter(function (i) { return i.magnetUrl; });
    if (filtered2.length > 0) return filtered2;
  } catch (e) { errors.push('Jackett: ' + e.message); }
  if (errors.length > 0) throw new Error(errors.join(' | '));
  return [];
}

// ============================================================================
// TORBOX TORRENT MANAGEMENT
// ============================================================================

async function findExistingTorrentByHash(infoHash, apiKey) {
  if (!infoHash) return null;
  var cfg = getConfig();
  var torrents = await torboxFetch('/torrents/mylist?limit=' + encodeURIComponent(cfg.maxExistingTorrentScan) + '&bypass_cache=true', {}, apiKey);
  var items = Array.isArray(torrents) ? torrents : (torrents ? [torrents] : []);
  var wantedHash = String(infoHash).toUpperCase();
  for (var i = 0; i < items.length; i++) {
    var torrent = items[i];
    var altHashes = Array.isArray(torrent.alternative_hashes) ? torrent.alternative_hashes : [];
    var candidates = [torrent.hash].concat(altHashes).filter(Boolean).map(function (v) { return String(v).toUpperCase(); });
    if (candidates.includes(wantedHash)) return torrent;
  }
  return null;
}

function chooseBestAudioFile(files) {
  var audioFiles = (Array.isArray(files) ? files : []).filter(function (f) {
    return isAudioName(f.name || f.short_name || '') || String(f.mimetype || '').startsWith('audio/');
  });
  if (audioFiles.length === 0) return null;
  return audioFiles.sort(function (a, b) {
    var qa = inferQualityFromTitle(a.name || a.short_name || '') === 'LOSSLESS' ? 1 : 0;
    var qb = inferQualityFromTitle(b.name || b.short_name || '') === 'LOSSLESS' ? 1 : 0;
    if (qa !== qb) return qb - qa;
    return (b.size || 0) - (a.size || 0);
  })[0];
}

async function waitForTorboxAudio(torrentId, apiKey) {
  var cfg = getConfig();
  var startedAt = Date.now();
  var timeoutMs = Number(cfg.torboxTimeoutMs) || 90000;
  var pollMs = Number(cfg.torboxPollIntervalMs) || 2500;
  while (Date.now() - startedAt < timeoutMs) {
    var torrent = await torboxFetch('/torrents/mylist?id=' + encodeURIComponent(torrentId) + '&bypass_cache=true', {}, apiKey);
    var audioFile = chooseBestAudioFile(torrent.files);
    if (audioFile && (torrent.download_finished || torrent.cached || torrent.download_present)) {
      return { torrent: torrent, file: audioFile };
    }
    await sleep(pollMs);
  }
  throw new Error('Timed out waiting for TorBox to prepare the audio file.');
}

async function resolveTrackToTorbox(trackPayload, apiKey) {
  var existing = await findExistingTorrentByHash(trackPayload.infoHash, apiKey);
  if (existing) {
    var existingFile = chooseBestAudioFile(existing.files);
    if (existingFile) return { torrentId: existing.id, fileId: existingFile.id, fileName: existingFile.name || existingFile.short_name || trackPayload.title };
  }
  var created = await torboxCreateTorrent(trackPayload.magnetUrl, trackPayload.title, apiKey);
  var ready = await waitForTorboxAudio(created.torrent_id, apiKey);
  return { torrentId: ready.torrent.id, fileId: ready.file.id, fileName: ready.file.name || ready.file.short_name || trackPayload.title };
}

// ============================================================================
// MODULE EXPORT
// ============================================================================

return {
  id: MODULE_ID,
  name: 'TorBox + Prowlarr/Jackett',
  version: '0.4.0',
  labels: ['TORBOX', 'PROWLARR', 'JACKETT', 'TORRENT'],
  supportedDebridProviders: ['torbox'],

  setConfig: setConfig,
  configure: setConfig,
  verifyTorBoxKey: verifyTorBoxKey,

  settings: {
    torboxApiKey: {
      type: 'debrid',
      label: 'TorBox Connection',
      description: 'Enter your TorBox API key to add torrents to your cloud. Get your key at torbox.app',
      provider: 'torbox',
      providerName: 'TorBox',
      providerLogo: TORBOX_LOGO,
      placeholder: 'Paste TorBox API Key...',
      verifyAction: 'verifyTorBoxKey'
    },
    prowlarrTorznabUrl: {
      type: 'text',
      label: 'Prowlarr URL',
      description: 'Your Prowlarr instance URL (e.g., http://localhost:9696)',
      placeholder: 'http://localhost:9696',
      defaultValue: ''
    },
    prowlarrApiKey: {
      type: 'text',
      label: 'Prowlarr API Key',
      description: 'API key from Prowlarr Settings > General',
      placeholder: 'Enter Prowlarr API Key...',
      defaultValue: ''
    },
    jackettTorznabUrl: {
      type: 'text',
      label: 'Jackett Torznab URL',
      description: 'Full Torznab endpoint from Jackett (fallback)',
      placeholder: 'http://localhost:9117/api/v2.0/indexers/all/results/torznab/api',
      defaultValue: ''
    },
    jackettApiKey: {
      type: 'text',
      label: 'Jackett API Key',
      description: 'API key from Jackett dashboard',
      placeholder: 'Enter Jackett API Key...',
      defaultValue: ''
    }
  },

  searchTracks: async function (query, limit, context) {
    var resolvedLimit = Number(limit || getConfig().searchLimit || 20);
    var results = await searchWithFallbacks(query, resolvedLimit, context);
    var tracks = results
      .map(function (result) {
        var parsed = parseTitleGuess(result.title);
        return {
          id: JSON.stringify({ source: result.source, title: result.title, magnetUrl: result.magnetUrl, infoHash: result.infoHash, seeders: result.seeders, size: result.size }),
          title: parsed.title,
          artist: parsed.artist,
          album: parsed.album || result.source,
          duration: 0,
          albumCover: '',
          _score: scoreSearchResult(query, result)
        };
      })
      .sort(function (a, b) { return b._score - a._score; })
      .slice(0, resolvedLimit)
      .map(function (track) {
        return { id: track.id, title: track.title, artist: track.artist, album: track.album, duration: track.duration, albumCover: track.albumCover };
      });
    return { tracks: tracks, total: tracks.length };
  },

  getTrackStreamUrl: async function (trackId, quality, context) {
    var apiKey = getKey(context);
    if (!apiKey) throw new Error('TorBox API key is missing.');
    var payload = typeof trackId === 'string' ? JSON.parse(trackId) : trackId;
    var resolved = await resolveTrackToTorbox(payload, apiKey);
    var streamUrl = await torboxFetch(
      '/torrents/requestdl?token=' + encodeURIComponent(apiKey) +
      '&torrent_id=' + encodeURIComponent(resolved.torrentId) +
      '&file_id=' + encodeURIComponent(resolved.fileId) +
      '&redirect=false&append_name=true',
      {},
      apiKey
    );
    return {
      streamUrl: streamUrl,
      track: { id: trackId, audioQuality: quality === 'LOSSLESS' ? 'LOSSLESS' : inferQualityFromTitle(resolved.fileName) }
    };
  }
};
