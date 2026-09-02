use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

/// Top-level user config. Lives next to the binary as `config.toml`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Config {
    /// Server bind address for the admin panel + overlay.
    pub server: ServerConfig,
    /// LLM provider settings.
    pub llm: LlmConfig,
    /// Audio capture settings.
    pub audio: AudioConfig,
    /// VAD / music filter.
    pub filter: FilterConfig,
    /// OBS WebSocket integration.
    pub obs: ObsConfig,
    /// Subtitle rendering hints (consumed by browser overlay).
    pub overlay: OverlayConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerConfig {
    pub host: String,
    pub port: u16,
    /// Path to the bundled `overlay/` and `admin/` static assets.
    /// Defaults are fine: main() overrides this with the real exe-relative
    /// path at startup; the field only needs to deserialize.
    #[serde(default = "default_static_dir")]
    pub static_dir: PathBuf,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LlmConfig {
    /// Provider identifier: `qwen-realtime`, `openai-realtime`, `mock`.
    pub provider: String,
    /// API key (Bearer / DashScope / OpenAI).
    pub api_key: String,
    /// Model name, e.g. `qwen3.5-livetranslate-flash-realtime`.
    pub model: String,
    /// WebSocket endpoint override (rarely needed).
    pub endpoint: Option<String>,
    /// Target output language. Always `"zh"` for this product.
    pub target_lang: String,
    /// Whether to translate Chinese input. `false` = pass through.
    pub translate_chinese: bool,
    /// Optional extra system prompt hint.
    pub system_prompt: Option<String>,
    /// 低延迟分段（毫秒）。0 = 关闭：沿用服务端 server_vad，等一句话说完
    /// 才整句返回（句子完整，但延迟≈整句话时长）。
    /// >0 = 开启：本机累计「正在说」的语音，每满该毫秒就发一次
    /// `input_audio_buffer.commit`，把当前已说的这一段提前识别/翻译并输出，
    /// 字幕按段持续推进，延迟可压到 ~1–2 秒（代价：长句被切成短段）。
    #[serde(default)]
    pub segment_ms: u64,
}

fn default_ingest_port() -> u16 {
    8788
}

fn default_static_dir() -> PathBuf {
    PathBuf::from("dist")
}

fn default_bg_opacity() -> u32 {
    75
}

fn default_border_radius() -> u32 {
    8
}

fn default_max_lines() -> u32 {
    2
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AudioConfig {
    /// `"system"` (loopback), `"device"` (input mic / specific output) or
    /// `"obs_filter"` (audio streamed in from the OBS plugin's capture
    /// filter; no system capture needed).
    pub mode: String,
    /// When mode=system on macOS, set true to capture system audio via
    /// ScreenCaptureKit (requires the user to grant permission once).
    pub use_screen_capture_kit: bool,
    /// Specific cpal device name. Empty = default.
    pub device: String,
    /// Sample rate. 0 = device default.
    pub sample_rate: u32,
    /// Channels. 0 = device default.
    pub channels: u16,
    /// TCP port on 127.0.0.1 that receives audio from the OBS plugin
    /// filter (mode = "obs_filter"). 0 disables the ingest listener.
    #[serde(default = "default_ingest_port")]
    pub ingest_port: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct FilterConfig {
    /// RMS threshold (0.0–1.0) below which we treat the segment as silence.
    pub silence_rms: f32,
    /// Spectral flatness threshold above which the segment is treated as music.
    pub music_spectral_flatness: f32,
    /// Minimum speech segment duration in ms before sending to the model.
    pub min_segment_ms: u32,
    /// Maximum segment duration in ms; we flush at this point even if no VAD end.
    pub max_segment_ms: u32,
}

impl Default for FilterConfig {
    fn default() -> Self {
        Self {
            silence_rms: 0.012,
            music_spectral_flatness: 0.55,
            min_segment_ms: 350,
            max_segment_ms: 8_000,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ObsConfig {
    /// Whether to attempt connecting to OBS on startup.
    pub auto_connect: bool,
    pub host: String,
    pub port: u16,
    /// OBS WebSocket password (if authentication is enabled).
    pub password: String,
    /// Whether to register a Custom Dock entry pointing to the admin panel.
    pub register_dock: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OverlayConfig {
    pub font_family: String,
    pub font_size: u32,
    pub font_color: String,
    pub background_color: String,
    pub background_opacity: f32,
    /// Background width in pixels. 0 = auto (fit content, one line).
    #[serde(default)]
    pub bg_width: u32,
    /// Background height in pixels. 0 = auto (exactly one line tall).
    #[serde(default)]
    pub bg_height: u32,
    /// Background border radius in pixels.
    #[serde(default = "default_border_radius")]
    pub border_radius: u32,
    /// Background opacity 0-100 (0 = fully transparent, 100 = opaque).
    /// Older config files predate this key, hence the explicit default.
    #[serde(default = "default_bg_opacity")]
    pub bg_opacity: u32,
    /// Max caption lines. Text that overflows wraps onto the next line up
    /// to this count (max 4), then gets clamped with an ellipsis. 1 = strict
    /// single line, 2 = the default (grow only when the text needs it).
    #[serde(default = "default_max_lines")]
    pub max_lines: u32,
    /// `bottom` / `top` / `middle`
    pub position: String,
    /// `single` / `double`
    pub layout: String,
    /// `typewriter` / `fade` / `slide`
    pub animation: String,
    /// When true, mirror lines in OBS via the optional text GDI+ source.
    pub mirror_to_text_source: bool,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            server: ServerConfig {
                host: "127.0.0.1".into(),
                port: 8787,
                static_dir: PathBuf::from("dist"),
            },
            llm: LlmConfig {
                provider: "qwen-realtime".into(),
                api_key: String::new(),
                model: "qwen3.5-livetranslate-flash-realtime".into(),
                endpoint: None,
                target_lang: "zh".into(),
                translate_chinese: false,
                system_prompt: None,
                segment_ms: 0,
            },
            audio: AudioConfig {
                mode: "system".into(),
                use_screen_capture_kit: true,
                device: String::new(),
                sample_rate: 16000,
                channels: 1,
                ingest_port: 8788,
            },
            filter: FilterConfig {
                silence_rms: 0.012,
                music_spectral_flatness: 0.55,
                min_segment_ms: 350,
                max_segment_ms: 8_000,
            },
            obs: ObsConfig {
                auto_connect: true,
                host: "127.0.0.1".into(),
                port: 4455,
                password: String::new(),
                register_dock: true,
            },
            overlay: OverlayConfig {
                font_family: "Noto Sans CJK SC, Microsoft YaHei, PingFang SC, sans-serif"
                    .into(),
                font_size: 48,
                font_color: "#FFFFFF".into(),
                background_color: "#000000".into(),
                background_opacity: 0.55,
                bg_width: 0,
                bg_height: 0,
                border_radius: 8,
                bg_opacity: 75,
                max_lines: 2,
                position: "bottom".into(),
                layout: "single".into(),
                animation: "typewriter".into(),
                mirror_to_text_source: false,
            },
        }
    }
}

impl Config {
    pub fn load_or_create(path: &Path) -> Result<Self> {
        if path.exists() {
            let raw = std::fs::read_to_string(path)
                .with_context(|| format!("read config {}", path.display()))?;
            let cfg: Config = toml::from_str(&raw)
                .with_context(|| format!("parse config {}", path.display()))?;
            Ok(cfg)
        } else {
            // First run. Prefer the embedded default template (so the binary
            // is truly self-contained), but fall back to the programmatic
            // default if the embedded asset is missing for some reason.
            let raw = crate::embedded::DEFAULT_CONFIG;
            let cfg: Config = toml::from_str(raw).unwrap_or_else(|_| Config::default());
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent).ok();
            }
            std::fs::write(path, raw)?;
            Ok(cfg)
        }
    }

    pub fn save(&self, path: &Path) -> Result<()> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).ok();
        }
        std::fs::write(path, toml::to_string_pretty(self)?)?;
        Ok(())
    }
}