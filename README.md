# DSH Bilibili Audio

给 DeepSeek Harness Web UI 用的 B 站音频播放器插件：左侧栏入口、BV 号 / 链接解析、关键词搜索、本地收藏，以及一条会跟着音乐频谱跳动的 RGB 迷你播放条。

## 功能

- **左侧栏入口**：点图标打开独立音频面板，面板切换 / 关闭都不影响播放
- **多种输入**：BV 号、av 号、`b23.tv` 短链、完整视频链接都能解析
- **关键词搜索**：搜索 B 站视频，可在「BV号 / 标题」两种模式下切换
- **播放控制**：播放 / 暂停、上一首 / 下一首、进度拖动、音量调节（音量持久化到 localStorage）
- **收藏列表**：本地持久化，重启不丢
- **迷你播放条**：固定在页面顶部，显示封面与标题，可直接暂停 / 切歌 / 关闭
- **RGB 频谱轮廓**：播放时轮廓外发光，颜色与亮度由实时频谱驱动——低频鼓点亮、安静段变暗，整圈缓慢旋转；窗口切到后台自动熄灭

## 目录结构

```
bilibili-audio/
├── index.js            # Host 半边：解析、搜索、音频流代理
├── client.js           # Client 半边：面板、迷你条、播放器、频谱光晕
├── cordis.patch.yml    # bundle 挂载声明
├── package.json
├── locale/
│   ├── zh.json
│   └── en.json
└── icon.svg
```

## 安装

插件以本地 bundle 形式挂载。先克隆到本地：

```bash
git clone <repo-url> bilibili-audio
```

然后在 DSH profile 的 `package.json` 里加依赖与 bundle：

```jsonc
{
  "dsh": { "profile": { "bundles": [ "...", "@local/dsh-bilibili-audio" ] } },
  "dependencies": { "@local/dsh-bilibili-audio": "link:<absolute-path-to>/bilibili-audio" }
}
```

装好依赖后重载 profile。也可以直接用 `plugin_manager` 工具安装本地 bundle。

## 使用

1. 点左侧栏的粉色播放图标打开面板
2. 输入框里填 BV 号 / 链接，或切到「标题」模式搜索
3. 选中结果开始播放，页面顶部会出现迷你条

## 技术说明

**Host 半边**（`index.js`）通过 `ctx.webServer` 注册三条 exact 路由：

| 路由 | 说明 |
| --- | --- |
| `GET /bili-audio/api/resolve?raw=` | 解析 BV / av / 短链，返回曲目信息与流地址 |
| `GET /bili-audio/api/search?keyword=` | 调用 B 站 wbi 搜索接口，返回视频列表 |
| `GET /bili-audio/api/stream?u=` | 代理音频流，支持 Range，仅放行白名单域名 |

音频流地址经 base64url 编码后传给客户端，规避跨域与防盗链。

**Client 半边**（`client.js`）注册三个槽位：

- `sidebar.panellist` —— 左侧栏入口
- `main` —— 主面板内容
- `shell.overlay` —— 顶部迷你条

频谱可视化使用 Web Audio `AnalyserNode`：优先 `createMediaElementSource`（仅当 `AudioContext` 已处于 `running` 才接管，避免把音频静音），否则退回不接管输出的 `captureStream`。亮度映射用固定 dB 窗口（`-45dB ~ -8dB`），避免正常音量就顶满。

## 说明与限制

- 依赖 B 站公开接口，接口调整可能导致解析或搜索失效
- 音频流代理仅放行白名单域名，不会变成任意 URL 代理
- 迷你条固定在页面顶部中央，位置不可拖动
- 仅供个人学习使用，请遵守 B 站服务条款

## License

MIT
