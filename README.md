!!!全程向大肥鱼许愿的产物 如有什么不妥或者bug欢迎B站私信我（ID：山乞yC）或者向大肥鱼许愿来完善QAQ
# DSH Bilibili Audio

给 DeepSeek Harness Web UI 用的 B 站音频播放器插件：左侧栏入口、BV 号 / 链接解析、关键词搜索、播放模式与翻页、本地收藏与本地音乐导入，以及一条会跟着音乐频谱跳动的 RGB 迷你播放条。

## 功能

- **左侧栏入口**：点图标打开独立音频面板，面板切换 / 关闭都不影响播放
- **多种输入**：BV 号、av 号、`b23.tv` 短链、完整视频链接都能解析
- **关键词搜索**：搜索 B 站视频，可在「BV号 / 标题」两种模式下切换；结果支持翻页（最多 50 页）
- **播放控制**：播放 / 暂停、上一首 / 下一首、进度拖动、音量调节（音量持久化到 localStorage）
- **播放模式**：顺序播放 / 单曲循环 / 随机播放，选择会记住
- **视图切换**：结果与收藏可在列表 / 网格之间切换
- **收藏列表**：本地持久化，重启不丢；支持在收藏里按歌名、UP 主或 BV 号搜索
- **本地音乐**：把本地音频文件（mp3 / m4a / flac / wav / ogg / opus / aac）导入收藏，文件存在 IndexedDB
- **迷你播放条**：固定在页面顶部，显示封面与标题，可直接暂停 / 切歌 / 关闭
- **RGB 频谱轮廓**：播放时轮廓外发光，颜色与亮度由实时频谱驱动——低频鼓点亮、安静段变暗，整圈缓慢旋转；窗口切到后台自动熄灭
- **失败不串歌**：切歌下载失败时不会把上一首当成当前曲目播放，按播放键会重试界面显示的那一首

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
├── icon.svg
├── README.md
├── LICENSE
└── .gitignore
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
2. 输入框里填 BV 号 / 链接，或切到「标题」模式搜索；结果可以翻页，也能切换列表 / 网格视图
3. 选中结果开始播放，页面顶部会出现迷你条
4. 想听本地文件就点收藏区底部的「导入」，选音频文件即可

## 技术说明

**Host 半边**（`index.js`）通过 `ctx.webServer` 注册五条 exact 路由：

| 路由 | 说明 |
| --- | --- |
| `GET /bili-audio/api/resolve?raw=` | 解析 BV / av / 短链，返回曲目信息与流地址 |
| `GET /bili-audio/api/search?keyword=&page=` | 调用 B 站 wbi 搜索接口，返回视频列表（`page` 1–50） |
| `GET /bili-audio/api/stream?u=&v=` | 代理音频流，支持 Range，仅放行白名单域名 |
| `GET /bili-audio/api/selftest` | seek 自检页，用于排查播放器的 `seekable` / `buffered` 行为 |
| `POST /bili-audio/api/report` | 接收播放器上报的播放状态，追加到临时日志 |

音频流地址经 base64url 编码后传给客户端，规避跨域与防盗链。

`stream` 路由带断流续传：CDN 中途断开时用 Range 从断点重连（最多 3 次），并给下游流挂 `error` 处理器，避免上游异常升级成 `uncaughtException` 带走 host 进程。

**Client 半边**（`client.js`）注册三个槽位：

- `sidebar.panellist` —— 左侧栏入口
- `main` —— 主面板内容
- `shell.overlay` —— 顶部迷你条

频谱可视化使用 Web Audio `AnalyserNode`：优先 `createMediaElementSource`（仅当 `AudioContext` 已处于 `running` 才接管，避免把音频静音），否则退回不接管输出的 `captureStream`。亮度映射用固定 dB 窗口（`-50dB ~ -12dB`），避免正常音量就顶满。

**播放链路**：桌面壳的 `dsh-app://` 不响应 Range 请求，直接把代理地址交给 `<audio>` 会得到 `seekable = [0,0]`、进度条拖不动。所以客户端先把整段音频 `fetch` 进内存，再给元素一个 `blob:` URL（创建失败则退回直连地址），seek 就完全走本地。本地导入的音乐同样以 Blob 从 IndexedDB 取出播放。

## 说明与限制

- 依赖 B 站公开接口，接口调整可能导致解析或搜索失效
- 音频流代理仅放行白名单域名，不会变成任意 URL 代理
- 迷你条固定在页面顶部中央，位置不可拖动
- 导入的本地音乐存在浏览器 IndexedDB，清理站点数据会一并丢失
- 仅供个人学习使用，请遵守 B 站服务条款

## License

MIT
