# @deepseek-ai/dsh-remote-app

PWA for remote dsh control: pair with a 6-digit code, browse the plugin inventory, and view settings — all over the shared remote-control protocol. It is a plain Vite static site with no framework; the phone browser's "add to home screen" makes it app-like.

## Run

```sh
pnpm --filter @deepseek-ai/dsh-remote-app dev
```

## Deploy

```sh
pnpm --filter @deepseek-ai/dsh-remote-app build
# serve apps/remote-app/dist from any static host, ideally HTTPS so the browser
# can reach the WSS relay
```

## Flow

1. Enter the relay URL (`wss://relay.example.com`) and the 6-digit pairing code shown in the dsh terminal.
2. The app pairs with the device and shows the plugin inventory.
3. Settings are read-only for now (JSON view); editing arrives with the settings form renderer.

The pairing token lives in memory only — refreshing the page requires re-pairing.
