export const TORBOX_TORZNAB_MODULE = `
const MODULE_ID = 'torbox-torznab';
const TORBOX_API_BASE = 'https://api.torbox.app/v1/api';
const TORBOX_SEARCH_API = 'https://search-api.torbox.app';
const TPB_API = 'https://apibay.org';
const TORBOX_LOGO = 'https://avatars.githubusercontent.com/u/144096078?s=280&v=4';
const AUDIO_EXT = ['flac','wav','aiff','alac','ape','m4a','aac','mp3','ogg','opus'];

function getKey(ctx) {
  var s = ctx && ctx.settings && ctx.settings.torboxApiKey;
  var v = s && typeof s === 'object' ? s.value : s;
  if (v && String(v).trim()) return String(v).trim();
  if (ctx && ctx.debridApiKey) return ctx.debridApiKey;
  return '';
}
function gs(ctx, k) { var s = ctx && ctx.settings && ctx.settings[k]; return s && typeof s === 'object' ? s.value : (s || ''); }
function sleep(ms) { return new Promise(function(r){ setTimeout(r, ms); }); }
function inferQ(n) { var l = String(n||'').toLowerCase(); return (l.indexOf('flac')!==-1||l.indexOf('lossless')!==-1||l.indexOf('24bit')!==-1) ? 'LOSSLESS' : 'HIGH'; }
function isAudio(n) { var p = String(n||'').toLowerCase().split('.'); return AUDIO_EXT.indexOf(p[p.length-1]) !== -1; }

async function verifyTorBoxKey(apiKey) {
  try {
    var r = await fetch(TORBOX_API_BASE + '/user/me', { headers: { 'Authorization': 'Bearer ' + apiKey } });
    var d = await r.json();
    if (!r.ok || !d.success) return { success: false, error: d.detail || 'Invalid API key' };
    var u = d.data || {};
    var plans = { 0:'Free', 1:'Essential', 2:'Pro', 3:'Standard' };
    return { success: true, accountName: u.email || u.username || 'TorBox User', plan: plans[u.plan] || ('Plan ' + u.plan), expiry: u.premium_expires_at ? new Date(u.premium_expires_at).toLocaleDateString() : 'Never' };
  } catch(e) { return { success: false, error: e.message }; }
}

async function searchTPB(query, limit) {
  var url = TPB_API + '/q.php?q=' + encodeURIComponent(query) + '&cat=101';
  var r = await fetch(url);
  if (!r.ok) throw new Error('TPB search HTTP ' + r.status);
  var json = await r.json();
  if (!Array.isArray(json) || (json.length === 1 && json[0].id === '0')) return [];
  var trackers = '&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337&tr=udp%3A%2F%2Fopen.tracker.cl%3A1337&tr=udp%3A%2F%2Ftracker.openbittorrent.com%3A80';
  return json
    .filter(function(i) { return Number(i.seeders) > 0; })
    .sort(function(a, b) { return Number(b.seeders) - Number(a.seeders); })
    .slice(0, limit || 20)
    .map(function(item) {
      var hash = String(item.info_hash || '').toUpperCase();
      var magnet = 'magnet:?xt=urn:btih:' + hash + '&dn=' + encodeURIComponent(item.name || '') + trackers;
      var parts = (item.name || '').replace(/[._-]/g, ' ').split(/  +/);
      var title = item.name || 'Unknown';
      var artist = 'Unknown Artist';
      var dash = title.indexOf(' - ');
      if (dash !== -1) { artist = title.substring(0, dash).trim(); title = title.substring(dash + 3).trim(); }
      return { id: JSON.stringify({ magnet: magnet, hash: hash, title: item.name || '' }), title: title, artist: artist, album: 'The Pirate Bay', duration: 0, albumCover: '' };
    });
}

async function searchProwlarr(query, limit, ctx) {
  var url = gs(ctx, 'prowlarrTorznabUrl'); var key = gs(ctx, 'prowlarrApiKey');
  if (!url) throw new Error('Prowlarr URL not set');
  var r = await fetch(url + '?t=music&q=' + encodeURIComponent(query) + '&cat=3000&extended=1&limit=' + (limit||20) + (key ? '&apikey=' + key : ''));
  if (!r.ok) throw new Error('Prowlarr HTTP ' + r.status);
  return parseXml(await r.text(), 'prowlarr');
}

async function searchJackett(query, limit, ctx) {
  var url = gs(ctx, 'jackettTorznabUrl'); var key = gs(ctx, 'jackettApiKey');
  if (!url) throw new Error('Jackett URL not set');
  var r = await fetch(url + '?t=music&q=' + encodeURIComponent(query) + '&cat=3000&extended=1&limit=' + (limit||20) + (key ? '&apikey=' + key : ''));
  if (!r.ok) throw new Error('Jackett HTTP ' + r.status);
  return parseXml(await r.text(), 'jackett');
}

async function searchTorboxUsenet(query, limit, ctx) {
  var apiKey = getKey(ctx);
  if (!apiKey) throw new Error('TorBox key required');
  var url = TORBOX_SEARCH_API + '/usenet/search/' + encodeURIComponent(query) + '?limit=' + (limit || 20);
  var r = await fetch(url, { headers: { 'Authorization': 'Bearer ' + apiKey } });
  if (!r.ok) throw new Error('TorBox usenet search HTTP ' + r.status);
  var json = await r.json();
  var nzbs = (json.data && json.data.nzbs) || [];
  return (Array.isArray(nzbs) ? nzbs : []).map(function(item) {
    var parts = (item.title || item.raw_title || '').split(' - ');
    return { id: JSON.stringify({ type:'usenet', hash: item.hash||'', nzb: item.nzb||'', title: item.title || item.raw_title || '', cached: item.cached||false }), title: parts[1] || parts[0] || item.title || 'Unknown', artist: parts[0] || 'Unknown Artist', album: 'TorBox Usenet', duration: 0, albumCover: '' };
  });
}

function xmlField(xml, tag) {
  var m = xml.match(new RegExp('<' + tag + '[^>]*>([\\s\\S]*?)<\\/' + tag + '>', 'i'));
  return m ? m[1].replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').trim() : '';
}
function xmlAttr(xml, attr) {
  var m = xml.match(new RegExp('<(?:torznab|newznab):attr[^>]*name="' + attr + '"[^>]*value="([^"]*)"','i'));
  return m ? m[1].trim() : '';
}
function xmlEnc(xml) { var m = xml.match(new RegExp('<enclosure[^>]*url="([^"]+)"', 'i')); return m ? m[1].trim() : ''; }

function parseXml(xml, source) {
  var items = xml.match(new RegExp('<item[^]*?<' + '/item>', 'gi')) || [];
  return items.map(function(itemXml) {
    var title = xmlField(itemXml, 'title');
    var link = xmlField(itemXml, 'link');
    var hash = xmlAttr(itemXml, 'infohash').toUpperCase();
    var mag = xmlAttr(itemXml, 'magneturl') || xmlEnc(itemXml) || (link.indexOf('magnet:')===0 ? link : '') || (hash ? 'magnet:?xt=urn:btih:' + hash : '');
    if (!mag) return null;
    var seeders = Number(xmlAttr(itemXml, 'seeders') || 0);
    var parts = title.split(' - ');
    return { id: JSON.stringify({ magnet: mag, hash: hash, title: title }), title: parts[1] || parts[0] || title, artist: parts[0] || 'Unknown Artist', album: source, duration: 0, albumCover: '' };
  }).filter(function(t) { return t !== null; });
}

async function searchLidarr(query, limit, ctx) {
  var url = gs(ctx, 'lidarrUrl').replace(/\/+$/, '');
  var key = gs(ctx, 'lidarrApiKey');
  if (!url || !key) throw new Error('Lidarr not configured');
  var r = await fetch(url + '/api/v1/album/lookup?term=' + encodeURIComponent(query), { headers: { 'X-Api-Key': key } });
  if (!r.ok) throw new Error('Lidarr HTTP ' + r.status);
  var albums = await r.json();
  if (!Array.isArray(albums) || !albums.length) return [];
  return albums.slice(0, limit || 20).map(function(album) {
    var artist = (album.artist && album.artist.artistName) || 'Unknown Artist';
    return {
      id: JSON.stringify({ type:'lidarr', artist: artist, album: album.title || '' }),
      title: album.title || 'Unknown',
      artist: artist,
      album: '',
      duration: 0,
      albumCover: ''
    };
  });
}

async function searchTracks(query, limit, ctx) {
  var lim = Number(limit || 20);
  // 1. Lidarr (best metadata + album art, if configured)
  if (gs(ctx, 'lidarrUrl') && gs(ctx, 'lidarrApiKey')) {
    try { var lr = await searchLidarr(query, lim, ctx); if (lr.length) return { tracks: lr.slice(0, lim), total: lr.length }; } catch(e) { console.warn('[TorBox] Lidarr:', e.message); }
  }
  // 2. TorBox usenet
  try {
    var ub = await searchTorboxUsenet(query, lim, ctx);
    if (ub.length) return { tracks: ub.slice(0, lim), total: ub.length };
  } catch(e) { console.warn('[TorBox] Usenet:', e.message); }
  // 3. Prowlarr (optional)
  if (gs(ctx, 'prowlarrTorznabUrl')) {
    try { var pr = await searchProwlarr(query, lim, ctx); if (pr.length) return { tracks: pr.slice(0, lim), total: pr.length }; } catch(e) { console.warn('[TorBox] Prowlarr:', e.message); }
  }
  // 4. Jackett (optional)
  if (gs(ctx, 'jackettTorznabUrl')) {
    try { var jr = await searchJackett(query, lim, ctx); if (jr.length) return { tracks: jr.slice(0, lim), total: jr.length }; } catch(e) { console.warn('[TorBox] Jackett:', e.message); }
  }
  // 5. TPB (last resort)
  var tr = await searchTPB(query, lim);
  return { tracks: tr.slice(0, lim), total: tr.length };
}

async function tbFetch(path, apiKey, opts) {
  var o = opts || {};
  var r = await fetch(TORBOX_API_BASE + path, { method: o.method||'GET', body: o.body||undefined, headers: Object.assign({ 'Authorization': 'Bearer ' + apiKey }, o.headers||{}) });
  var d = await r.json();
  if (!r.ok || d.success === false) throw new Error(d.detail || d.error || 'TorBox error');
  return d.data;
}

async function addTorrent(magnet, title, apiKey) {
  var f = new FormData();
  f.append('magnet', magnet); f.append('name', title||'8spine'); f.append('seed','3'); f.append('allow_zip','false'); f.append('as_queued','false'); f.append('add_only_if_cached','false');
  return tbFetch('/torrents/createtorrent', apiKey, { method: 'POST', body: f });
}

function bestAudio(files) {
  var audio = (Array.isArray(files) ? files : []).filter(function(f) { return isAudio(f.name||f.short_name||'') || String(f.mimetype||'').indexOf('audio/')===0; });
  if (!audio.length) return null;
  return audio.sort(function(a,b) { var qa=inferQ(a.name||'')==='LOSSLESS'?1:0,qb=inferQ(b.name||'')==='LOSSLESS'?1:0; return qa!==qb?qb-qa:(b.size||0)-(a.size||0); })[0];
}

async function waitForAudio(torrentId, apiKey) {
  var start = Date.now(), timeout = 90000, poll = 2500;
  while (Date.now()-start < timeout) {
    var t = await tbFetch('/torrents/mylist?id=' + encodeURIComponent(torrentId) + '&bypass_cache=true', apiKey, {});
    var f = bestAudio(t.files);
    if (f && (t.download_finished||t.cached||t.download_present)) return { torrent: t, file: f };
    await sleep(poll);
  }
  throw new Error('Timed out waiting for TorBox.');
}

async function findByHash(hash, apiKey) {
  if (!hash) return null;
  var list = await tbFetch('/torrents/mylist?limit=100&bypass_cache=true', apiKey, {});
  var items = Array.isArray(list) ? list : (list ? [list] : []);
  var want = String(hash).toUpperCase();
  for (var i=0; i<items.length; i++) {
    var t = items[i];
    var alts = Array.isArray(t.alternative_hashes) ? t.alternative_hashes : [];
    var hs = [t.hash].concat(alts).filter(Boolean).map(function(h){ return String(h).toUpperCase(); });
    if (hs.indexOf(want) !== -1) return t;
  }
  return null;
}

async function addUsenet(hash, nzbUrl, title, apiKey) {
  var f = new FormData();
  if (hash) f.append('hash', hash);
  if (nzbUrl) f.append('link', nzbUrl);
  f.append('name', title || '8spine');
  f.append('as_queued', 'false');
  return tbFetch('/usenet/createusenetdownload', apiKey, { method: 'POST', body: f });
}

async function waitForUsenet(usenetId, apiKey) {
  var start = Date.now(), timeout = 90000, poll = 2500;
  while (Date.now()-start < timeout) {
    var u = await tbFetch('/usenet/mylist?id=' + encodeURIComponent(usenetId) + '&bypass_cache=true', apiKey, {});
    var f = bestAudio(u.files);
    if (f && (u.download_finished || u.cached || u.download_present)) return { item: u, file: f };
    await sleep(poll);
  }
  throw new Error('Timed out waiting for TorBox usenet.');
}

async function getTrackStreamUrl(trackId, quality, ctx) {
  var apiKey = getKey(ctx);
  if (!apiKey) throw new Error('TorBox API key is missing.');
  var payload = typeof trackId === 'string' ? JSON.parse(trackId) : trackId;

  if (payload.type === 'lidarr') {
    // Auto-find via TorBox usenet then TPB
    var q = payload.artist + ' ' + payload.album;
    try {
      var usenetHits = await searchTorboxUsenet(q, 3, ctx);
      if (usenetHits.length) {
        var up = JSON.parse(usenetHits[0].id);
        var addedU = await addUsenet(up.hash, up.nzb, up.title, apiKey);
        var uid = addedU.usenetdownload_id || addedU.id;
        var rdyU = await waitForUsenet(uid, apiKey);
        var suU = await tbFetch('/usenet/requestdl?token=' + encodeURIComponent(apiKey) + '&usenet_id=' + encodeURIComponent(uid) + '&file_id=' + encodeURIComponent(rdyU.file.id) + '&redirect=false', apiKey, {});
        return { streamUrl: suU, track: { id: trackId, audioQuality: inferQ(rdyU.file.name||'') } };
      }
    } catch(e) { console.warn('[TorBox] Lidarr usenet stream:', e.message); }
    var tpbHits = await searchTPB(q, 3);
    if (!tpbHits.length) throw new Error('No results found for: ' + q);
    payload = JSON.parse(tpbHits[0].id);
    // fall through to torrent path below
  }

  if (payload.type === 'usenet') {
    var added = await addUsenet(payload.hash, payload.nzb, payload.title, apiKey);
    var usenetId = added.usenetdownload_id || added.id;
    var ready = await waitForUsenet(usenetId, apiKey);
    var streamUrl = await tbFetch('/usenet/requestdl?token=' + encodeURIComponent(apiKey) + '&usenet_id=' + encodeURIComponent(usenetId) + '&file_id=' + encodeURIComponent(ready.file.id) + '&redirect=false', apiKey, {});
    return { streamUrl: streamUrl, track: { id: trackId, audioQuality: quality==='LOSSLESS'?'LOSSLESS':inferQ(ready.file.name||'') } };
  }

  var existing = await findByHash(payload.hash, apiKey);
  var torrentId, fileId, fileName;
  if (existing) { var ef = bestAudio(existing.files); if (ef) { torrentId=existing.id; fileId=ef.id; fileName=ef.name||ef.short_name||payload.title; } }
  if (!torrentId) {
    var created = await addTorrent(payload.magnet, payload.title, apiKey);
    var rdy = await waitForAudio(created.torrent_id, apiKey);
    torrentId=rdy.torrent.id; fileId=rdy.file.id; fileName=rdy.file.name||rdy.file.short_name||payload.title;
  }
  var streamUrl2 = await tbFetch('/torrents/requestdl?token=' + encodeURIComponent(apiKey) + '&torrent_id=' + encodeURIComponent(torrentId) + '&file_id=' + encodeURIComponent(fileId) + '&redirect=false&append_name=true', apiKey, {});
  return { streamUrl: streamUrl2, track: { id: trackId, audioQuality: quality==='LOSSLESS'?'LOSSLESS':inferQ(fileName) } };
}

return {
  id: MODULE_ID, name: 'TorBox + Lidarr/Prowlarr', version: '1.0.0',
  labels: ['TORBOX','LIDARR','PROWLARR','JACKETT'],
  supportedDebridProviders: ['torbox'],
  verifyTorBoxKey: verifyTorBoxKey,
  searchTracks: searchTracks,
  getTrackStreamUrl: getTrackStreamUrl,
  settings: {
    torboxApiKey: { type:'debrid', label:'TorBox Connection', description:'Enter your TorBox API key. Get yours at torbox.app', provider:'torbox', providerName:'TorBox', providerLogo: TORBOX_LOGO, placeholder:'Paste TorBox API Key...', verifyAction:'verifyTorBoxKey' },
    lidarrUrl: { type:'text', label:'Lidarr URL', description:'Your Lidarr instance URL. Enables rich metadata + album art in search results.', placeholder:'http://localhost:8686', defaultValue:'' },
    lidarrApiKey: { type:'text', label:'Lidarr API Key', description:'From Lidarr Settings > General', placeholder:'Enter Lidarr API Key...', defaultValue:'' },
    prowlarrTorznabUrl: { type:'text', label:'Prowlarr URL', description:'Optional. e.g. http://localhost:9696/1/api', placeholder:'http://localhost:9696/1/api', defaultValue:'' },
    prowlarrApiKey: { type:'text', label:'Prowlarr API Key', description:'Optional. From Prowlarr Settings > General', placeholder:'Enter Prowlarr API Key...', defaultValue:'' },
    jackettTorznabUrl: { type:'text', label:'Jackett Torznab URL', description:'Optional. Fallback search source', placeholder:'http://localhost:9117/api/v2.0/indexers/all/results/torznab/api', defaultValue:'' },
    jackettApiKey: { type:'text', label:'Jackett API Key', description:'Optional. From Jackett dashboard', placeholder:'Enter Jackett API Key...', defaultValue:'' }
  }
};
`;
