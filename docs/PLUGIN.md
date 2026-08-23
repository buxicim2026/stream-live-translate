# OBS 插件模式指南

从 v0.7.0 起，Stream Live Translate 以**正式 OBS 插件**形式分发：把插件文件夹复制进 OBS 的插件目录即可使用，无需安装器。

## 架构

```
plugins/stream-live-translate/              ← 复制进 OBS 插件目录
├── bin/64bit/stream-live-translate.dll     ← C 薄壳插件（Linux 为 .so，macOS 为 .plugin bundle）
└── data/
    ├── locale/{en-US,zh-CN}.ini            ← 滤镜界面文案
    └── engine/stream-live-translate(.exe)  ← Rust 引擎（字幕/管理面板全部内嵌）
```

两个组件的分工：

| 组件 | 职责 |
| --- | --- |
| C 薄壳插件 | 注册"实时字幕捕获"音频滤镜；OBS 启动时自动拉起引擎进程、退出时自动回收 |
| Rust 引擎 | VAD/音乐检测、自动语言检测、大模型流式翻译、字幕广播、管理面板（`http://127.0.0.1:8787`） |

数据流：

```
OBS 源（媒体源/窗口采集/…）
   │  挂上"实时字幕捕获"滤镜
   ▼
音频滤镜（混音成单声道 → 线性重采样 16kHz → s16le）
   │  本地 TCP 127.0.0.1:8788（SLTA 协议）
   ▼
引擎 ingest → VAD/音乐检测（静音和音乐不送模型）→ 自动语言检测
   ▼
大模型（中文直通、其他语言同传成中文）
   ▼
字幕广播 → OBS 浏览器源（/overlay）
```

## 安装（免安装，复制即用）

从 GitHub Releases 下载对应平台的插件包并解压，把 `stream-live-translate` 文件夹**整个**放到：

| 平台 | 插件目录（推荐，无需管理员权限） |
| --- | --- |
| Windows | `%APPDATA%\obs-studio\plugins\` |
| Linux | `~/.config/obs-studio/plugins/` |
| macOS (Apple Silicon) | `~/Library/Application Support/obs-studio/plugins/` |

> **注意**：必须保留解压后的目录结构，即最终路径形如
> `%APPDATA%\obs-studio\plugins\stream-live-translate\bin\64bit\stream-live-translate.dll`。
> OBS **不会**扫描安装目录下的 `plugins\` 文件夹；如果要装进 OBS 安装目录，
> dll 要放 `<OBS安装目录>\obs-plugins\64bit\`，data 目录要放 `<OBS安装目录>\data\obs-plugins\stream-live-translate\`（需要管理员权限，一般不推荐）。放好后重启 OBS。

> macOS 首次使用若被 Gatekeeper 拦截，对解压出来的文件执行一次
> `xattr -dr com.apple.quarantine stream-live-translate.plugin`。

## 使用

1. **挂滤镜**：右键任意源（媒体源、窗口采集、显示器采集等）→ **滤镜** → 左下角 `+` → **实时字幕捕获**。只挂到你要出字幕的那个源上即可。
2. **填 API Key**：OBS 菜单 **视图 → 停靠部件 → 自定义浏览器停靠部件**，名称随意（比如"字幕控制台"），URL 填 `http://127.0.0.1:8787/admin`。侧边栏就会出现管理面板，填入大模型 API Key 并保存。这一步只需做一次。
3. **加字幕源**：在场景里添加一个 **浏览器** 源，URL 填 `http://127.0.0.1:8787/overlay`，建议 1920×240。字幕就出现在画面上了。
4. 开播。说话出中文字幕；放音乐或静音时自动跳过（不会产生字幕，也不消耗 token）。

### 滤镜设置项

| 设置 | 说明 |
| --- | --- |
| 启用捕获 | 关掉后滤镜透传音频、不再发送 |
| 丢弃静音帧 | 实验性；进一步省流量，但可能让字幕收尾稍慢，默认关闭 |
| 引擎接收端口 | 默认 8788，一般不用改；改了需与引擎 `config.toml` 的 `audio.ingest_port` 一致 |

### 独立运行模式（不用 OBS 插件也能用）

引擎仍然保留独立程序形态：把 `data/engine/` 里的可执行文件放到任意目录双击运行，`config.toml` 里把 `audio.mode` 改成 `"system"` 即回到系统音频环回模式（功能与 v0.6.x 相同）。

## Ingest 协议（滤镜 → 引擎）

本地 TCP `127.0.0.1:8788`，小端序：

```
4 字节    魔数 "SLTA"
u32       载荷采样率（滤镜固定发 16000）
u32       格式：0 = 单声道 s16le
...       连续 s16le PCM
```

引擎按 20ms 切帧送入既有的 VAD/音乐检测管线。断线后滤镜每 500ms 自动重连；引擎崩溃时滤镜也会持续尝试重连。

## 手动编译

> 不想手动编译的话：给仓库打一个 `v*` tag，GitHub Actions（`plugin.yml`）自动产出三平台插件包到 Releases。

### Windows x64

前置：Rust（MSVC ABI）、Visual Studio Build Tools（C++ 工作负载）、CMake、Git。

```powershell
# 在 "Developer PowerShell for VS" 里执行：
.\scripts\package-plugin.ps1
# 产物：release\stream-live-translate-obs-win-x64-<版本>.zip
```

脚本做的事：`cargo build --release` 编译引擎 → 浅克隆 obs-studio 拿 libobs 头文件 → 从已安装 OBS（或自动下载的官方发布包）的 `obs.dll` 用 dumpbin+lib 生成导入库 → CMake 编译插件 → 组装打包。
**不需要编译 OBS 本身**，符号在运行时由已安装的 OBS 解析。

### Linux x64

前置：Rust、gcc/clang、cmake、git、`libasound2-dev`（编译 cpal 用）。

```bash
bash scripts/package-plugin.sh
# 产物：release/stream-live-translate-obs-linux-x64-<版本>.tar.gz
```

链接用带 `soname=libobs.so.0` 的桩共享库，运行时符号由已安装的 OBS 提供。

### macOS（Apple Silicon）

前置：Rust、Xcode Command Line Tools、cmake、git。

```bash
bash scripts/package-plugin.sh
# 产物：release/stream-live-translate-obs-macos-arm64-<版本>.tar.gz
#       （内含 stream-live-translate.plugin bundle）
```

模块以 `-undefined dynamic_lookup` 链接，运行时符号由 OBS 进程解析。

## 验收清单

- [ ] OBS 启动后日志出现 `[SLT] Stream Live Translate plugin loaded`
- [ ] 引擎被自动拉起（任务管理器/`ps` 里可见），无控制台窗口弹出
- [ ] 滤镜可添加到任意源，设置面板三项正常显示（中/英双语）
- [ ] `127.0.0.1:8787/admin` 能打开、填 Key 保存成功
- [ ] 媒体源播放中文语音 → `/overlay` 出中文字幕
- [ ] 媒体源播放外语 → 字幕是同传中文
- [ ] 播放音乐 / 静音一段时间 → 无新字幕产生
- [ ] 关闭 OBS → 引擎进程随之退出（Windows 通过 Job Object 保证）

## 故障排查

| 现象 | 排查 |
| --- | --- |
| OBS 日志没有 `[SLT]` | 插件文件夹位置不对；确认 `bin/64bit/xxx.dll` 层级正确 |
| 滤镜加上了但没字幕 | 检查管理面板状态；确认 `config.toml` 里 `audio.mode = "obs_filter"`（插件拉起引擎时会自动写入） |
| 引擎没被拉起 | 查看 OBS 日志中 `[SLT] failed to spawn engine`；macOS 注意 quarantine 属性 |
| 端口冲突 | 改滤镜"引擎接收端口"+`config.toml` 的 `ingest_port` 为同一个空闲端口 |
