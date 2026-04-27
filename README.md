# 8spine TorBox Module

An 8spine module that uses Prowlarr and Jackett as fallback for music search, streamed through TorBox.

## Add to 8spine

Paste this into 8spine and enter your TorBox API key:

`https://github.com/nvmindl/8spine-torbox-torznab-module`

## Config

```js
module.configure({
  torboxApiKey: 'your-torbox-key',
  prowlarrTorznabUrl: 'http://localhost:9696/1/api',
  prowlarrApiKey: 'your-prowlarr-key',
  jackettTorznabUrl: 'http://localhost:9117/api/v2.0/indexers/all/results/torznab/api',
  jackettApiKey: 'your-jackett-key'
});
```

## How it works

1. Searches Prowlarr first, falls back to Jackett if nothing comes back
2. Sends the magnet to TorBox
3. Waits for an audio file, then returns the stream URL to 8spine
