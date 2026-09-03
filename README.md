# Stream Live Translate

> 实时 AI 字幕 / 同声传译 OBS 插件 —— 从 OBS 媒体源内部取音频 + 大模型流式翻译 + 浏览器源字幕叠加。

**免安装：把插件文件夹复制进 OBS 的插件目录就能用。**OBS 启动时插件自动拉起内置引擎，给任意源挂上“实时字幕捕获”滤镜，填上你自己的大模型 API Key，中文字幕就出现在直播画面上了。详细安装/使用/编译说明见 [docs/PLUGIN.md](docs/PLUGIN.md)。

## 功能一览

| 功能 | 说明 |
| --- | --- |
| OBS 原生插件 | 复制插件文件夹到 OBS 插件目录即用，无需安装器；OBS 启动自动拉起引擎、退出自动回收 |
| OBS 内部取音频 | 音频滤镜直接捕获媒体源等任意源的声音，不受系统其它声音干扰 |
| 跨平台 | Windows 10/11 x64、Linux x64（Debian 11+/Ubuntu 20.04+）、macOS 13+（Apple Silicon） |
| 侧边栏控制台 | 管理面板通过 OBS 自带“自定义浏览器停靠部件”钉在侧边栏，填 Key/调样式不用切出 OBS |
| 流式翻译 | Qwen3.5-LiveTranslate-Flash-Realtime WebSocket 流式接口，低延迟 |
| 自动语言检测 | 中文直通不翻译；其它语种自动同传为中文 |
| VAD + 音乐检测 | 检测到静音或音乐时跳过该片段，省 token 也不污染字幕 |
| 浏览器源字幕 | 字幕以 Browser Source 呈现，可自定义字体、颜色、动画 |
| API Key 本地保存 | 配置只存在本地 `config.toml`，不联网回传 |
| 独立运行模式 | 不用 OBS 插件也能单独跑，系统音频环回模式保留（见 docs/USAGE.md） |

## 模型兼容性

插件需要能**实时接收流式音频、并边听边返回字幕文字**的语音（多模态）Realtime 模型。

**可用**：通义 Qwen Realtime 语音（同传 / ASR / Qwen-Audio）、智谱 GLM-Realtime、OpenAI Realtime、FunASR 本地流式识别，以及 OpenAI 兼容的本地 Realtime 网关（如 huggingface/speech-to-speech）。

**不可用**：纯文本 / 纯视觉模型、纯语音合成（TTS）、非实时流式接口——它们无法“听”实时音频，即使能连上也不会有字幕。

配置时可参考 admin 面板右上“模型适配说明”（弹窗）与各厂商的下拉提示。

## 系统要求

| 平台 | 最低版本 | 系统依赖 |
| --- | --- | --- |
| **Windows** | Windows 10 1809+ | 无（MSVC 链接器在 cargo build 阶段就静态进二进制了） |
| **macOS** | macOS 13 (Ventura) | 仅 Apple Silicon（M1 / M2 / M3 / M4） |
| **Linux x64** | Ubuntu 20.04 LTS / Debian 11 (glibc 2.31+) | `libasound2` (alsa) + `ffmpeg`（推荐） |
| **Linux arm64** | Ubuntu 20.04 LTS / Debian 11 (glibc 2.31+) | 同上 |

> 没有 musl 静态版本（alsa 不是 Rust crate，无法静态链）。**glibc ≥ 2.31** 已覆盖目前所有受支持的 Debian / Ubuntu 发行版。

## 快速使用（插件模式）

### 1. 安装插件（复制即用）

从 Releases 下载对应平台的插件包（`stream-live-translate-obs-<平台>-<版本>.zip/.tar.gz`），解压后把 `stream-live-translate` 文件夹放进：

| 平台 | 插件目录（推荐，无需管理员权限） |
| --- | --- |
| Windows | `%APPDATA%\obs-studio\plugins\` |
| Linux | `~/.config/obs-studio/plugins/` |
| macOS | `~/Library/Application Support/obs-studio/plugins/` |

也可以放进 OBS 安装目录下的 `plugins\` 文件夹。然后启动/重启 OBS。

### 2. 挂音频滤镜（告诉插件听哪个源）

右键你要出字幕的源（媒体源、窗口采集等）→ **滤镜** → `+` → **实时字幕捕获**。

### 3. 侧边栏控制台填 API Key（一次性）

OBS 菜单 **视图 → 停靠部件 → 自定义浏览器停靠部件**，URL 填 `http://127.0.0.1:8787/admin`；侧边栏出现管理面板，填入大模型 API Key 保存。

### 4. 加字幕源

场景里添加 **浏览器** 源，URL `http://127.0.0.1:8787/overlay`，建议 1920×240。

### 5. 开播

说话出中文字幕；外语自动同传成中文；放音乐/静音时自动跳过。

## 便携模式（Portable Mode）

插件启动时**总是**优先把 `config.toml` 放在可执行文件同目录：

```
my-folder/
├── stream-live-translate(.exe)    ← 主程序
├── config.toml                     ← 自动生成；填了 API Key 之后所有设置都保存在这里
├── stream-live-translate.log       ← 运行日志（可选，tracing 控制）
└── dist/                           ← 可选；如果存在且包含 admin/overlay 子目录，优先用本地版本
                                      （用于自定义前端界面；不影响单文件分发的核心）
```

要点：

- **移动整个文件夹 = 迁移所有设置**。`config.toml` 不会被藏到 `%APPDATA%` 或 `~/.config/`，跟你看到的文件在一起。
- 如果安装目录是只读（例如 `/usr/local/bin/` 或 `C:\Program Files\`），插件会**自动回退**到系统用户配置目录：`%APPDATA%\stream-live-translate\config.toml`（Windows）或 `~/.config/stream-live-translate/config.toml`（Linux/macOS）。日志会打印实际使用的路径。
- 用 `--config <path>` 命令行参数可以强行指定 config 路径（覆盖上述所有规则）。
- `SLT_CONFIG=<path>` 环境变量也行（CI 友好）。

> 旧版本会把 config 写到 `%TEMP%` 之类的临时目录，每次启动都重置。**已经修了**——升级后请把旧 config 内容复制进新位置一次。

## 编译

引擎本体（Rust）最短路径：

```bash
# 任何平台都只需要装 Rust 1.74+ 和系统基础依赖
cargo build --release
# 产物在 target/release/stream-live-translate(.exe)
```

**OBS 插件包**（含 C 薄壳插件 + 引擎，三平台）见 [docs/PLUGIN.md](docs/PLUGIN.md)：本地跑 `scripts/package-plugin.ps1`（Windows）/ `scripts/package-plugin.sh`（Linux/macOS）；或者直接打 `v*` tag，GitHub Actions（`plugin.yml`）自动产出三平台插件包到 Releases，下载即用。

跨平台引擎发布包仍由 `.github/workflows/release.yml` 在打 tag 时自动构建（4 个目标）。

## 本地打发布包

```bash
# OBS 插件包（推荐，正式产品形态）
#   Windows：.\scripts\package-plugin.ps1
#   Linux / macOS：bash scripts/package-plugin.sh

# 独立程序发布包（系统环回模式）
# Windows
./scripts/build-all.ps1
# Linux / macOS
./scripts/build-all.sh
```

脚本会：

1. 在当前平台编译 release 二进制
2. 输出一个**只包含单文件二进制 + README + SHA256** 的发布包（zip 或 tar.gz）

发布包结构（举例 Linux）：

```
linux-x64.tar.gz
└── linux-x64/
    ├── stream-live-translate      ← 主程序（HTML/CSS/JS 已内嵌）
    └── README.txt                 ← Debian/Ubuntu 装依赖一行命令
```

## 目录结构

```
stream-live-translate/
├── Cargo.toml
├── src/                  # Rust 引擎（单二进制）
│   ├── main.rs           # CLI / 启动 / 便携模式 config 解析（--audio-mode 供插件注入）
│   ├── audio.rs          # cpal 跨平台音频环回（独立模式用）
│   ├── ingest.rs         # OBS 滤镜音频接收（TCP/SLTA 协议）
│   ├── vad.rs            # 静音 / 音乐检测
│   ├── llm.rs            # 大模型流式客户端
│   ├── lang.rs           # 语言检测
│   ├── server.rs         # HTTP / WS 服务 + 字幕广播
│   ├── obs.rs            # obs-websocket 客户端 + 自动 dock 源
│   ├── pipeline.rs       # audio -> LLM -> subtitle 管线
│   ├── subtitle.rs       # 字幕事件总线
│   ├── config.rs         # toml 配置（load / save / merge patch）
│   └── embedded.rs       # compile-time 内嵌 dist/ 资源
├── plugin/               # C 薄壳 OBS 插件（滤镜 + 引擎进程管理 + CMake + locale）
├── overlay/              # 浏览器源字幕页面
├── admin/                # 管理面板
├── dist/                 # 内嵌资源 + 启动器 + 默认 config.toml
├── scripts/              # 引擎打包 + OBS 插件打包脚本（三平台）
├── docs/                 # 详细文档（PLUGIN.md = 插件模式指南）
└── .github/workflows/    # CI：release.yml 引擎 / plugin.yml 三平台插件包
```

## 文档

- [docs/PLUGIN.md](docs/PLUGIN.md) —— **OBS 插件模式：安装、使用、三平台编译**
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) —— 模块拓扑、数据流
- [docs/BUILD.md](docs/BUILD.md) —— 各种环境下从源码编译
- [docs/USAGE.md](docs/USAGE.md) —— 完整使用文档、API 列表
- [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) —— 常见问题

## 许可

MIT
