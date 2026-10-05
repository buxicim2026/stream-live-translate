<div align="center">

📺 **B站：[不息传播](https://space.bilibili.com/385015308)** ｜ 💬 **微信公众号：不息传播**

# 直播译站（Stream Live Translate）

**看直播，不用再猜别人在说什么。**

一款面向 OBS Studio 的实时字幕 / 同声传译插件，帮助你在 OBS 直播、录播、赛事解说、游戏直播、发布会和跨语言内容中，更快理解并展示直播信息。

[![GitHub release](https://img.shields.io/github/v/release/buxicim2026/stream-live-translate?style=flat-square)](https://github.com/buxicim2026/stream-live-translate/releases)
[![GitHub stars](https://img.shields.io/github/stars/buxicim2026/stream-live-translate?style=social)](https://github.com/buxicim2026/stream-live-translate)
[![Sponsor](https://img.shields.io/static/v1?label=Sponsor&message=%E2%9D%A4&logo=GitHub&color=%23fe8e86)](https://github.com/sponsors/buxicim2026)

</div>

---

## 目录

[项目介绍](#项目介绍)  [主要特点](#主要特点)  [适用场景](#适用场景)  [安装方法](#安装方法)  [快速使用](#快速使用)  [模型兼容性](#模型兼容性)  [更新日志](#更新日志) 
[支持项目](#支持项目)  [联系与反馈](#联系与反馈)  [许可证](#许可证)

---

## 项目介绍

**直播译站（Stream Live Translate）** 是一个专注于 OBS Studio 直播场景的实时字幕 / 同声传译插件。

它的主要目标是：  
让你在 OBS 中直播、录播或转播外语内容时，不必再手动处理音频到翻译软件，也不必因为语言不通而错过关键信息。

无论是海外主播说话、外语赛事解说、游戏直播交流、数码发布会，还是跨语言连麦内容，直播译站都可以帮助你在 OBS 画面中直接生成并叠加中文字幕。

项目名称：

- 英文名：`Stream Live Translate`
- 中文名：**直播译站**

一句话介绍：

> **直播译站，让你的 OBS 直播具备实时翻译能力。**

---

## 主要特点

### 🎬 面向 OBS Studio

OBS Studio 插件（30+以上版本）  
复制插件文件夹到 OBS 插件目录即可使用，OBS 启动时自动拉起内置引擎，几乎不占用一点空间。

### 🎧 OBS 内部取音频

通过 OBS 音频滤镜直接捕获媒体源等任意源的声音，不受系统其它声音干扰，适合直播场景。

### ⚡ 实时流式翻译

接入支持流式音频的大模型 Realtime 接口，低延迟返回字幕，边听边译。

### 🌍 自动语言检测

中文直通不翻译（方言也通用）；其它语种（常用外国语言）自动同传为中文，减少手动切换。（要视乎不同模型的能力）

### 🧠 VAD + 音乐检测

检测到静音或音乐片段时自动跳过，节省 token，也避免污染字幕。

### 🖥 浏览器源字幕

字幕以 OBS 浏览器源呈现，可自定义字体、颜色、大小和背景效果。

### 🎛 侧边栏控制台

管理面板通过 OBS 自带“自定义浏览器停靠部件”钉在侧边栏，填 Key、调样式不用切出 OBS。

### 🔐 API Key 本地保存

配置只存在本地 `config.toml`，不联网回传，不使用任何中转站，使用更安心。

### 🧩 跨平台

支持 Windows 10/11 x64、Linux x64（Debian 11+/Ubuntu 20.04+）、macOS 13+（Apple Silicon）。

### 🔓 开源透明

项目托管在 GitHub，代码公开可见，可提交问题和建议。

---

## 适用场景

直播译站适合以下 OBS 使用场景：

- 在 OBS 中直播海外主播内容；
- 转播外语游戏直播；
- 转播数码汽车产品发布会；
- 给跨语言直播添加中文字幕；
- 录播外语视频并生成字幕；
- 需要临时辅助理解不同直播内容。

简单来说：

> 只要你在 OBS 里处理直播 / 录播，并且遇到语言理解障碍，直播译站就可以尝试帮到你。

---

## 安装方法

详细安装与配置请查看 [USAGE.md](USAGE.md)。

简要步骤：

1. 从 [Releases](https://github.com/buxicim2026/stream-live-translate/releases) 下载最新版本压缩包。
2. 解压后，将 `stream-live-translate` 文件夹复制到 OBS 插件目录。（该部分需要查看详细安装流程[USAGE.md](USAGE.md)）
3. 重启 OBS。
4. 在 OBS 中打开“自定义浏览器停靠部件”，添加直播译站管理面板。
5. 填入你自己使用的大模型 API Key，选择模型，保存。
6. 给媒体源添加“实时字幕捕获”滤镜，并添加浏览器源字幕层。

---

## 快速使用

1. 在 OBS 中右键需要翻译的媒体源。
2. 选择“滤镜” → 添加滤镜 → **实时字幕捕获**。
3. 添加一个 **浏览器源** 作为字幕显示层，URL 填入管理面板中显示的地址。
4. 调整浏览器源大小和位置。
5. 开始直播 / 录制，字幕会自动出现。

---

## 模型兼容性

插件需要能**实时接收流式音频、并边听边返回字幕文字**的语音（多模态）Realtime 模型。

**云端可用**：

- 通义 Qwen Realtime 语音（同传 / ASR / Qwen-Audio）
- 智谱 GLM-Realtime
- OpenAI Realtime

通义新版已适配：

- `qwen3.5-livetranslate-flash-realtime`
- `qwen3.8-livetranslate-flash-realtime`（推荐）
- `qwen-audio-3.1-asr-flash-message` / `-streaming`（推荐）
- `qwen-audio-3.1-realtime-plus`
- `qwen3.8-omni-flash-realtime`

---

## 更新日志

### v0.0.34

- **新增**：浏览器源字幕支持自定义 CSS 动画效果
- **优化**：VAD 静音检测灵敏度调优，减少误跳过
- **优化**：WebSocket 断线重连逻辑，提升弱网环境稳定性
- **修复**：修复 Linux 下部分音频源无法捕获的问题
- **修复**：修复管理面板在 OBS 深色主题下部分文字不可见的问题
- **修复**：修复字幕换行在长文本场景下偶尔错位的问题

---

## 支持项目

如果这个项目对你有帮助，欢迎通过 GitHub Sponsors 支持我继续维护：

[![Sponsor](https://img.shields.io/static/v1?label=Sponsor&message=%E2%9D%A4&logo=GitHub&color=%23fe8e86)](https://github.com/sponsors/buxicim2026)

你也可以在仓库页面点击右上角的 **Sponsor** 按钮进行捐赠。

> 提示：仓库右上角 Sponsor 按钮需要先在 GitHub 仓库的 **Settings → Sponsorships** 中启用，并确保 `.github/FUNDING.yml` 包含：
>
> ```yaml
> github: buxicim2026
> ```

---

## 联系与反馈

- B站：[不息传播](https://space.bilibili.com/385015308)
- 微信公众号：不息传播
- GitHub Issues：[提交问题](https://github.com/buxicim2026/stream-live-translate/issues)

---

## 许可证

本项目采用 MIT 许可证。详见 [LICENSE](LICENSE) 文件。
