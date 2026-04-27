# 8spine TorBox Module

An 8spine module that uses **Prowlarr** and **Jackett** as fallback search sources, then uses **TorBox** for playback.

Files:

- `8spine-torbox-module.js`

## Flow

1. 8spine calls `searchTracks(query, limit)`
2. The module searches **Prowlarr** first using Torznab `t=music`
3. If Prowlarr returns no usable magnet results, it falls back to **Jackett**
4. When a track is selected, the module adds the magnet to **TorBox**
5. The module polls TorBox until an audio file is available
6. The module returns a direct `requestdl` URL to 8spine

## Install

Add this repo to 8spine:

`{here add the module url for 8spine}`

Then enter your TorBox API key.

## Required config

The module needs:

- `torboxApiKey`
- `prowlarrTorznabUrl`
- `prowlarrApiKey`
- `jackettTorznabUrl`
- `jackettApiKey`

## Suggested URLs

Use the **full Torznab endpoint URL** from your apps instead of guessing paths in code.

Examples:

- Prowlarr: `http://localhost:9696/1/api`
- Jackett: `http://localhost:9117/api/v2.0/indexers/all/results/torznab/api`

If your setup uses reverse proxies or different indexer IDs, use those exact URLs instead.

## Config methods

The module accepts config through:

1. `setConfig({...})`
2. `configure({...})`
3. `globalThis.__EIGHTSPINE_MODULE_CONFIG__['torbox-torznab']`

Example:

```js
module.configure({
  torboxApiKey: 'TORBOX_KEY',
  prowlarrTorznabUrl: 'http://localhost:9696/1/api',
  prowlarrApiKey: 'PROWLARR_KEY',
  jackettTorznabUrl: 'http://localhost:9117/api/v2.0/indexers/all/results/torznab/api',
  jackettApiKey: 'JACKETT_KEY'
});
```

## Notes

- The module currently searches with Torznab `t=music` and category `3000` by default.
- Some indexers return better music metadata than others, so title parsing is best-effort.
- If TorBox has to fetch an uncached torrent, playback may take time because the module waits for a real audio file before returning the stream URL.
- The current wait timeout is 90 seconds by default.
