# 直播译站（Stream Live Translate）使用教程

> 本文只讲怎么用，不涉及源码编译，也不列出源码目录结构。

---

## 一、安装插件

1. 打开 [Releases](https://github.com/buxicim2026/stream-live-translate/releases) 页面。
2. 下载最新版本的压缩包。
3. 解压后，将 `stream-live-translate` 文件夹复制到 OBS 的插件目录：
   - **Windows**：解压之后，文件要复制到OBS安装目录， dll文件要放 <OBS安装目录>\obs-plugins\64bit\，data目录要放 <OBS安装目录>\data\obs-plugins\stream-live-translate\（需要管理员权限，需要自行新建stream-live-translate\文件夹）。放好后重启 OBS。
   - **Linux**：`~/.config/obs-studio/plugins/`
   - **macOS**：`~/Library/Application Support/obs-studio/plugins/`
4. 重启 OBS。

---

## 二、配置大模型 API Key

1. 在 OBS 顶部菜单打开 **“停靠部件” → “自定义浏览器停靠部件”**。
2. 添加直播译站管理面板。
3. 在管理面板中填入你的大模型 API Key：
   - 通义千问：前往 [阿里云百炼（千问AI平台）](https://bailian.console.aliyun.com/) 获取
   - 智谱 GLM：前往 [智谱开放平台](https://open.bigmodel.cn/) 获取
   - OpenAI：前往 [OpenAI Platform](https://platform.openai.com/) 获取
   - （使用自己的api key你应该懂的，这部分得花钱的，如果你不知道怎么部署，直接找我要定制专属版本）
4. 选择合适的模型（推荐 `qwen3.8-livetranslate-flash-realtime` `qwen-audio-3.1-asr-flash-message`）。
5. 点击保存。

---

## 三、在 OBS 中开始使用

1. 在 OBS 中，右键需要翻译的 **媒体源**（如视频采集设备、媒体源等）。
2. 选择 **“滤镜” → 添加滤镜 → 实时字幕捕获**。
3. 添加一个字幕显示层：
   - 点击 **“来源”面板的 + 号 → 浏览器**。
   - URL 填入管理面板中显示的地址。
   - 根据需要调整宽度和高度。
4. 开始直播或录制，字幕会自动出现在画面中。

---

## 四、使用建议

- 建议先在本机录屏测试，确认字幕位置和大小合适后再正式直播。
- 如果直播中音乐较多，可保持 VAD / 音乐检测开启，避免音乐片段被误翻译。
- 中文内容会自动直通，不会重复翻译。
- 如果网络波动，插件会尝试自动重连 WebSocket。

---

## 五、常见问题

**Q：字幕不显示？**  
A：检查 API Key 是否填写正确，是否选择了支持实时流式翻译的模型，以及浏览器源 URL 是否与管理面板一致。

**Q：翻译延迟高？**  
A：尝试更换网络环境，或选择延迟更低的模型接口。

**Q：中文内容也被翻译了？**  
A：插件会自动检测中文并直通不翻译。如果出现异常，请检查源音频的语言设置。（部分模型没有翻译功能）

**Q：如何调整字幕样式？**  
A：在管理面板中可以自定义字体、颜色、大小和背景效果。

**Q：OBS 里找不到管理面板？**  
A：请确认插件已正确复制到 OBS 插件目录，并重启 OBS。然后在“停靠部件”中查找。

---

## 六、v0.0.34 变更日志

- **新增**：浏览器源字幕支持自定义 CSS 动画效果
- **优化**：VAD 静音检测灵敏度调优，减少误跳过
- **优化**：WebSocket 断线重连逻辑，提升弱网环境稳定性
- **修复**：修复 Linux 下部分音频源无法捕获的问题
- **修复**：修复管理面板在 OBS 深色主题下部分文字不可见的问题
- **修复**：修复字幕换行在长文本场景下偶尔错位的问题
