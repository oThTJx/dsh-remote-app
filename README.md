# @firefly0621/dsh-remote-app

English | [中文](README.zh.md)

PWA for remote dsh control: pair once with a QR scan or a 6-digit code, browse the plugin inventory, and view settings — all over the shared remote-control protocol. It is a plain Vite static site with no framework; the phone browser's "add to home screen" makes it app-like.

## Run

```sh
pnpm --filter @firefly0621/dsh-remote-app dev
```

## Deploy

```sh
pnpm --filter @firefly0621/dsh-remote-app build
# serve apps/remote-app/dist from any static host, ideally HTTPS so the browser
# can reach the WSS relay
```

## Flow

1. Open the app: it auto-resumes a previously paired session from its stored token; otherwise it shows the pairing screen.
2. Pair once — tap **扫码连接** to scan the QR shown in the host's 设置 → 插件 → 远程控制 panel, or enter the relay URL and the 6-digit code manually.
3. The app shows the plugin inventory; the settings tab renders every namespace as a JSON view (editing is not implemented yet).

The pairing token is kept in `localStorage`, so refreshing or reopening the app resumes the session without re-pairing. Re-pair only becomes necessary when the host removes the device (设置 → 插件 → 远程控制 → 已配对设备), resets its identity, or the relay loses its persisted sessions (`DSH_RELAY_DATA_DIR` not set and restarted).
