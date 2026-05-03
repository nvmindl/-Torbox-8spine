export const TORBOX_TORZNAB_MODULE = `
const MODULE_ID = 'torbox-torznab';
const TORBOX_API_BASE = 'https://api.torbox.app/v1/api';
const TORRENTIO_API = 'https://torrentio-addon-626866336386.europe-west4.run.app/music';
const TORBOX_LOGO = 'https://avatars.githubusercontent.com/u/144096078?s=280&v=4';
const AUDIO_EXTENSIONS = ['flac', 'wav', 'aiff', 'alac', 'ape', 'm4a', 'aac', 'mp3', 'ogg', 'opus'];

function getKey(context) {
  var setting = context && context.settings && context.settings.torboxApiKey;
  var fromSetting = setting && typeof setting === 'object' ? setting.value : setting;
  if (fromSetting && String(fromSetting).trim()) return String(fromSetting).trim();
  if (context && context.debridApiKey) return context.debridApiKey;
  return '';
}

function getSetting(context, key) {
  var s = context && context.settings && context.settings[key];
  return s && typeof s === 'object' ? s.value : (s || '');
}

function sleep(ms) {
  return new Promise(function (r) { setTimeout(r, ms); });
}

function inferQuality(name) {
  var l = String(name || '').toLowerCase();
  if (l.includes('flac') || l.includes('lossless') || l.includes('24bit') || l.includes('16bit')) return 'LOSSLESS';
  return 'HIGH';
}

function isAudio(name) {
  var ext = String(name || '').toLowerCase().split('.').pop();
  return AUDIO_EXTENSIONS.includes(ext);
}

// ── TorBox account verify ──────────────────────────────────────────────────

async function verifyTorBoxKey(apiKey) {
  try {
    var r = await fetch(TORBOX_API_BASE + '/user/me', {
      headers: { 'Authorization': 'Bearer ' + apiKey }
    });
    var d = await r.json();
    if (!r.ok || !d.success) return { success: false, error: d.detail || 'Invalid API key' };
    var u = d.data || {};
    var plans = { 0: 'Free', 1: 'Essential', 2: 'Pro', 3: 'Standard' };
    return {
      success: true,
      accountName: u.email || u.username || 'TorBox User',
      plan: plans[u.plan] || 'Plan ' + u.plan,
      expiry: u.premium_expires_at ? new Date(u.premium_expires_at).toLocaleDateString() : 'Never'
    };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// ── Search ─────────────────────────────────────────────────────────────────

async function searchTorrentio(query, limit) {
  var url = TORRENTIO_API + '/search?q=' + encodeURIComponent(query) + '&limit=' + (limit || 20);
  var r = await fetch(url);
  if (!r.ok) throw new Error('Torrentio search failed: HTTP ' + r.status);
  var json = await r.json();
  return (json.results || []).map(function (item, i) {
    var hash = item.infoHash || item.info_hash || '';
    var magnet = item.magnetLink || item.magnet || (hash ? 'magnet:?xt=urn:btih:' + hash : '');
    return {
      id: hash ? 'tor:' + hash : 'idx:' + i,
      title: item.title || 'Unknown',
      artist: item.artist || 'Unknown Artist',
      album: item.album || (item.sizeFormatted || 'Torrent'),
      duration: 0,
      albumCover: '',
      _magnet: magnet,
      _hash: hash,
      _seeders: item.seeders || 0,
      _size: item.size || 0,
      _quality: item.format || ''
    };
  });
}

async function searchProwlarr(query, limit, context) {
  var url = getSetting(context, 'prowlarrTorznabUrl');
  var key = getSetting(context, 'prowlarrApiKey');
  if (!url) throw new Error('Prowlarr URL not set');
  var searchUrl = url + '?t=music&q=' + encodeURIComponent(query) + '&cat=3000&extended=1&limit=' + (limit || 20) + (key ? '&apikey=' + key : '');
  var r = await fetch(searchUrl);
  if (!r.ok) throw new Error('Prowlarr HTTP ' + r.status);
  var xml = await r.text();
  return parseXmlItems(xml, 'prowlarr');
}

async function searchJackett(query, limit, context) {
  var url = getSetting(context, 'jackettTorznabUrl');
  var key = getSetting(context, 'jackettApiKey');
  if (!url) throw new Error('Jackett URL not set');
  var searchUrl = url + '?t=music&q=' + encodeURIComponent(query) + '&cat=3000&extended=1&limit=' + (limit || 20) + (key ? '&apikey=' + key : '');
  var r = await fetch(searchUrl);
  if (!r.ok) throw new Error('Jackett HTTP ' + r.status);
  var xml = await r.text();
  return parseXmlItems(xml, 'jackett');
}

function xmlField(xml, tag) {
  var m = xml.match(new RegExp('<' + tag + '[^>]*>([\\s\\S]*?)<\\/' + tag + '>', 'i'));
  return m ? m[1].trim() : '';
}
function xmlAttr(xml, name) {
  var m = xml.match(new RegExp('<(?:torznab|newznab):attr[^>]*name="' + name + '"[^>]*value="([^"]*)"', 'i'));
  return m ? m[1].trim() : '';
}
function xmlEnclosure(xml) {
  var m = xml.match(/<enclosure[^>]*url="([^"]+)"/i);
  return m ? m[1].trim() : '';
}

function parseXmlItems(xml, source) {
  var items = xml.match(/<item[\s\S]*?<\/item>/gi) || [];
  return items.map(function (itemXml, i) {
    var title = xmlField(itemXml, 'title');
    var link = xmlField(itemXml, 'link');
    var hash = xmlAttr(itemXml, 'infohash').toUpperCase();
    var mag = xmlAttr(itemXml, 'magneturl') || xmlEnclosure(itemXml) || (link.startsWith('magnet:') ? link : '') || (hash ? 'magnet:?xt=urn:btih:' + hash : '');
    var seeders = Number(xmlAttr(itemXml, 'seeders') || 0);
    var size = Number(xmlAttr(itemXml, 'size') || xmlField(itemXml, 'size') || 0);
    var parts = title.replace(/\.(flac|mp3|wav|aac|ogg|opus)$/i, '').replace(/[._]/g, ' ').split(/\s+-\s+/);
    return {
      id: JSON.stringify({ magnet: mag, hash: hash, title: title }),
      title: parts[1] || parts[0] || title,
      artist: parts[0] || 'Unknown Artist',
      album: source,
      duration: 0,
      albumCover: '',
      _magnet: mag,
      _hash: hash,
      _seeders: seeders,
      _size: size,
      _quality: inferQuality(title)
    };
  }).filter(function (t) { return t._magnet; });
}

async function searchTracks(query, limit, context) {
  var resolvedLimit = Number(limit || 20);
  var prowlarrUrl = getSetting(context, 'prowlarrTorznabUrl');
  var jackettUrl = getSetting(context, 'jackettTorznabUrl');

  // If Prowlarr or Jackett configured, try them first
  if (prowlarrUrl) {
    try {
      var pr = await searchProwlarr(query, resolvedLimit, context);
      if (pr.length > 0) return { tracks: pr.slice(0, resolvedLimit), total: pr.length };
    } catch (e) { console.warn('[TorBox] Prowlarr failed:', e.message); }
  }
  if (jackettUrl) {
    try {
      var jr = await searchJackett(query, resolvedLimit, context);
      if (jr.length > 0) return { tracks: jr.slice(0, resolvedLimit), total: jr.length };
    } catch (e) { console.warn('[TorBox] Jackett failed:', e.message); }
  }

  // Always fall back to Torrentio (no config needed)
  var tr = await searchTorrentio(query, resolvedLimit);
  var tracks = tr.map(function (t) {
    return { id: JSON.stringify({ magnet: t._magnet, hash: t._hash, title: t.title }), title: t.title, artist: t.artist, album: t.album, duration: 0, albumCover: '' };
  });
  return { tracks: tracks.slice(0, resolvedLimit), total: tracks.length };
}

// ── TorBox streaming ───────────────────────────────────────────────────────

async function tbFetch(path, apiKey, opts) {
  var o = opts || {};
  var r = await fetch(TORBOX_API_BASE + path, {
    method: o.method || 'GET',
    body: o.body || undefined,
    headers: Object.assign({ 'Authorization': 'Bearer ' + apiKey }, o.headers || {})
  });
  var d = await r.json();
  if (!r.ok || d.success === false) throw new Error(d.detail || d.error || 'TorBox error');
  return d.data;
}

async function addTorrent(magnet, title, apiKey) {
  var f = new FormData();
  f.append('magnet', magnet);
  f.append('name', title || '8spine');
  f.append('seed', '3');
  f.append('allow_zip', 'false');
  f.append('as_queued', 'false');
  f.append('add_only_if_cached', 'false');
  return tbFetch('/torrents/createtorrent', apiKey, { method: 'POST', body: f });
}

function bestAudio(files) {
  var audio = (Array.isArray(files) ? files : []).filter(function (f) {
    return isAudio(f.name || f.short_name || '') || String(f.mimetype || '').startsWith('audio/');
  });
  if (!audio.length) return null;
  return audio.sort(function (a, b) {
    var qa = inferQuality(a.name || '') === 'LOSSLESS' ? 1 : 0;
    var qb = inferQuality(b.name || '') === 'LOSSLESS' ? 1 : 0;
    return qa !== qb ? qb - qa : (b.size || 0) - (a.size || 0);
  })[0];
}

async function waitForAudio(torrentId, apiKey) {
  var start = Date.now();
  var timeout = 90000;
  var poll = 2500;
  while (Date.now() - start < timeout) {
    var t = await tbFetch('/torrents/mylist?id=' + encodeURIComponent(torrentId) + '&bypass_cache=true', apiKey, {});
    var f = bestAudio(t.files);
    if (f && (t.download_finished || t.cached || t.download_present)) return { torrent: t, file: f };
    await sleep(poll);
  }
  throw new Error('Timed out waiting for TorBox.');
}

async function findByHash(hash, apiKey) {
  if (!hash) return null;
  var list = await tbFetch('/torrents/mylist?limit=100&bypass_cache=true', apiKey, {});
  var items = Array.isArray(list) ? list : (list ? [list] : []);
  var want = String(hash).toUpperCase();
  for (var i = 0; i < items.length; i++) {
    var t = items[i];
    var alts = Array.isArray(t.alternative_hashes) ? t.alternative_hashes : [];
    var hashes = [t.hash].concat(alts).filter(Boolean).map(function (h) { return String(h).toUpperCase(); });
    if (hashes.indexOf(want) !== -1) return t;
  }
  return null;
}

async function getTrackStreamUrl(trackId, quality, context) {
  var apiKey = getKey(context);
  if (!apiKey) throw new Error('TorBox API key is missing. Please add it in module settings.');

  var payload = typeof trackId === 'string' ? JSON.parse(trackId) : trackId;
  var magnet = payload.magnet;
  var hash = payload.hash;
  var title = payload.title;

  // Check if already in TorBox
  var existing = await findByHash(hash, apiKey);
  var torrentId, fileId, fileName;

  if (existing) {
    var ef = bestAudio(existing.files);
    if (ef) {
      torrentId = existing.id;
      fileId = ef.id;
      fileName = ef.name || ef.short_name || title;
    }
  }

  if (!torrentId) {
    var created = await addTorrent(magnet, title, apiKey);
    var ready = await waitForAudio(created.torrent_id, apiKey);
    torrentId = ready.torrent.id;
    fileId = ready.file.id;
    fileName = ready.file.name || ready.file.short_name || title;
  }

  var streamUrl = await tbFetch(
    '/torrents/requestdl?token=' + encodeURIComponent(apiKey) +
    '&torrent_id=' + encodeURIComponent(torrentId) +
    '&file_id=' + encodeURIComponent(fileId) +
    '&redirect=false&append_name=true',
    apiKey, {}
  );

  return {
    streamUrl: streamUrl,
    track: { id: trackId, audioQuality: quality === 'LOSSLESS' ? 'LOSSLESS' : inferQuality(fileName) }
  };
}

// ── Module export ──────────────────────────────────────────────────────────

return {
  id: MODULE_ID,
  name: 'TorBox + Prowlarr/Jackett',
  version: '0.5.0',
  labels: ['TORBOX', 'PROWLARR', 'JACKETT', 'TORRENT'],
  supportedDebridProviders: ['torbox'],
  verifyTorBoxKey: verifyTorBoxKey,
  searchTracks: searchTracks,
  getTrackStreamUrl: getTrackStreamUrl,
  settings: {
    torboxApiKey: {
      type: 'debrid',
      label: 'TorBox Connection',
      description: 'Enter your TorBox API key. Get yours at torbox.app',
      provider: 'torbox',
      providerName: 'TorBox',
      providerLogo: TORBOX_LOGO,
      placeholder: 'Paste TorBox API Key...',
      verifyAction: 'verifyTorBoxKey'
    },
    prowlarrTorznabUrl: {
      type: 'text',
      label: 'Prowlarr URL',
      description: 'Optional. Your Prowlarr Torznab URL (e.g. http://localhost:9696/1/api)',
      placeholder: 'http://localhost:9696/1/api',
      defaultValue: ''
    },
    prowlarrApiKey: {
      type: 'text',
      label: 'Prowlarr API Key',
      description: 'Optional. From Prowlarr Settings > General',
      placeholder: 'Enter Prowlarr API Key...',
      defaultValue: ''
    },
    jackettTorznabUrl: {
      type: 'text',
      label: 'Jackett Torznab URL',
      description: 'Optional. Jackett fallback URL',
      placeholder: 'http://localhost:9117/api/v2.0/indexers/all/results/torznab/api',
      defaultValue: ''
    },
    jackettApiKey: {
      type: 'text',
      label: 'Jackett API Key',
      description: 'Optional. From Jackett dashboard',
      placeholder: 'Enter Jackett API Key...',
      defaultValue: ''
    }
  }
};
`;
