# @firefly0621/dsh-remote-app

[English](README.md) | 中文

用于远程控制 dsh 的 PWA：用 QR 扫码或 6 位配对码配对一次，即可浏览插件清单并查看设置——全部走共享的远程控制协议。它是纯 Vite 静态站点、无框架；手机浏览器的"添加到主屏幕"使其获得 App 体验。

## 运行

```sh
pnpm --filter @firefly0621/dsh-remote-app dev
```

## 部署

```sh
pnpm --filter @firefly0621/dsh-remote-app build
# serve apps/remote-app/dist from any static host, ideally HTTPS so the browser
# can reach the WSS relay
```

## 流程

1. 打开应用：若此前配对过，用存储的 token 自动恢复会话；否则显示配对页。
2. 配对一次——点 **扫码连接** 扫描 host 的 设置 → 插件 → 远程控制 面板中的 QR 码，或手动输入中继地址与 6 位配对码。
3. 应用显示插件清单；聊天页可选择一个 host 会话并流式显示回复；设置页以 JSON 视图渲染每个命名空间（编辑尚未实现）。

配对 token 存于 `localStorage`，因此刷新或重新打开应用无需重新配对即可恢复会话。仅当 host 移除设备（设置 → 插件 → 远程控制 → 已配对设备）、重置身份，或中继丢失持久会话（未设 `DSH_RELAY_DATA_DIR` 且已重启）时才需要重新配对。
