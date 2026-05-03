export const TORBOX_TORZNAB_MODULE = `
const MODULE_ID = 'torbox-torznab';
const TORBOX_API_BASE = 'https://api.torbox.app/v1/api';
const TORRENTIO_API = 'https://torrentio-addon-626866336386.europe-west4.run.app/music';
const TORBOX_SEARCH_API = 'https://search-api.torbox.app';
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

async function searchTorrentio(query, limit) {
  var url = TORRENTIO_API + '/search?q=' + encodeURIComponent(query) + '&limit=' + (limit || 20);
  var r = await fetch(url);
  if (!r.ok) throw new Error('Torrentio search HTTP ' + r.status);
  var json = await r.json();
  return (json.results || []).map(function(item, i) {
    var hash = item.infoHash || item.info_hash || '';
    var magnet = item.magnetLink || item.magnet || (hash ? 'magnet:?xt=urn:btih:' + hash : '');
    return { id: JSON.stringify({ magnet: magnet, hash: hash, title: item.title || '' }), title: item.title || 'Unknown', artist: item.artist || 'Unknown Artist', album: item.album || 'Torrent', duration: 0, albumCover: '' };
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
  var url = TORBOX_SEARCH_API + '/usenet/search/' + encodeURIComponent(query) + '?check_cache=true&check_owned=true';
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

async function searchTracks(query, limit, ctx) {
  var lim = Number(limit || 20);
  if (gs(ctx, 'prowlarrTorznabUrl')) {
    try { var pr = await searchProwlarr(query, lim, ctx); if (pr.length) return { tracks: pr.slice(0, lim), total: pr.length }; } catch(e) { console.warn('[TorBox] Prowlarr:', e.message); }
  }
  if (gs(ctx, 'jackettTorznabUrl')) {
    try { var jr = await searchJackett(query, lim, ctx); if (jr.length) return { tracks: jr.slice(0, lim), total: jr.length }; } catch(e) { console.warn('[TorBox] Jackett:', e.message); }
  }
  try {
    var tr = await searchTorrentio(query, lim);
    if (tr.length) return { tracks: tr.slice(0, lim), total: tr.length };
  } catch(e) { console.warn('[TorBox] Torrentio:', e.message); }
  var ub = await searchTorboxUsenet(query, lim, ctx);
  return { tracks: ub.slice(0, lim), total: ub.length };
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
  id: MODULE_ID, name: 'TorBox + Prowlarr/Jackett', version: '0.7.0',
  labels: ['TORBOX','TORRENT','PROWLARR','JACKETT'],
  supportedDebridProviders: ['torbox'],
  verifyTorBoxKey: verifyTorBoxKey,
  searchTracks: searchTracks,
  getTrackStreamUrl: getTrackStreamUrl,
  settings: {
    torboxApiKey: { type:'debrid', label:'TorBox Connection', description:'Enter your TorBox API key. Get yours at torbox.app', provider:'torbox', providerName:'TorBox', providerLogo: TORBOX_LOGO, placeholder:'Paste TorBox API Key...', verifyAction:'verifyTorBoxKey' },
    prowlarrTorznabUrl: { type:'text', label:'Prowlarr URL', description:'Optional. e.g. http://localhost:9696/1/api', placeholder:'http://localhost:9696/1/api', defaultValue:'' },
    prowlarrApiKey: { type:'text', label:'Prowlarr API Key', description:'Optional. From Prowlarr Settings > General', placeholder:'Enter Prowlarr API Key...', defaultValue:'' },
    jackettTorznabUrl: { type:'text', label:'Jackett Torznab URL', description:'Optional. Fallback search source', placeholder:'http://localhost:9117/api/v2.0/indexers/all/results/torznab/api', defaultValue:'' },
    jackettApiKey: { type:'text', label:'Jackett API Key', description:'Optional. From Jackett dashboard', placeholder:'Enter Jackett API Key...', defaultValue:'' }
  }
};
`;
