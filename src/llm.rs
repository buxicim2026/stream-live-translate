//! LLM provider abstraction. Each provider turns PCM s16le mono audio into
//! a stream of `SubtitleEvent`s. The pipeline doesn't care which provider is
//! plugged in.
//!
//! Currently implemented:
//!   * `qwen-realtime` — Aliyun DashScope realtime translation
//!     (Qwen3.5-LiveTranslate-Flash-Realtime and similar). Speaks a tiny
//!     JSON-over-WebSocket protocol.
//!   * `openai-realtime` — OpenAI gpt-4o-realtime / gpt-4o-mini-realtime
//!     when the user wants to drive ASR + translation themselves.
//!   * `mock` — emits canned Chinese sentences; useful for end-to-end
//!     UI/UX testing without burning API quota.

use anyhow::{anyhow, Context, Result};
use async_trait::async_trait;
use base64::Engine;
use futures::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio_tungstenite::tungstenite::{client::IntoClientRequest, http, Message};
use tracing::{debug, info, warn};

use crate::config::LlmConfig;
use crate::subtitle::{SubtitleEvent, SubtitleSink};

#[async_trait]
pub trait LlmProvider: Send + Sync {
    /// Provider identifier (e.g. `qwen-realtime`).
    fn name(&self) -> &'static str;

    /// Open the streaming session. `on_event` is invoked for every partial
    /// or final transcript the model produces.
    async fn run(
        self: Arc<Self>,
        audio_rx: tokio::sync::mpsc::Receiver<Vec<i16>>,
        sink: SubtitleSink,
    ) -> Result<()>;
}

pub fn build(cfg: &LlmConfig) -> Result<Arc<dyn LlmProvider>> {
    match cfg.provider.as_str() {
        "qwen-realtime" => Ok(Arc::new(qwen::QwenRealtime::new(cfg.clone())?)),
        "openai-realtime" => Ok(Arc::new(openai::OpenAiRealtime::new(cfg.clone())?)),
        "mock" => Ok(Arc::new(mock::MockProvider::new(cfg.clone())?)),
        other => Err(anyhow!("unknown LLM provider `{other}`")),
    }
}

// ---------- Qwen DashScope realtime ----------

pub mod qwen {
    use super::*;

    const DEFAULT_ENDPOINT: &str = "wss://dashscope.aliyuncs.com/api-ws/v1/realtime";

    pub struct QwenRealtime {
        cfg: LlmConfig,
        endpoint: String,
    }

    impl QwenRealtime {
        pub fn new(cfg: LlmConfig) -> Result<Self> {
            let endpoint = cfg
                .endpoint
                .clone()
                .unwrap_or_else(|| DEFAULT_ENDPOINT.to_string());
            if cfg.api_key.is_empty() {
                return Err(anyhow!("Qwen API key is empty; please fill it in the admin panel"));
            }
            Ok(Self { cfg, endpoint })
        }
    }

    #[async_trait]
    impl LlmProvider for QwenRealtime {
        fn name(&self) -> &'static str {
            "qwen-realtime"
        }

        async fn run(
            self: Arc<Self>,
            mut audio_rx: tokio::sync::mpsc::Receiver<Vec<i16>>,
            sink: SubtitleSink,
        ) -> Result<()> {
            let url = format!("{}?model={}", self.endpoint, self.cfg.model);
            // Pre-build the failure message: `url` is consumed by
            // into_client_request() below.
            let conn_ctx = format!("连接 Qwen 实时服务失败 ({url})");
            let mut req = url
                .into_client_request()
                .with_context(|| "build qwen ws request")?;
            req.headers_mut()
                .insert("Authorization", http::HeaderValue::from_str(&format!("Bearer {}", self.cfg.api_key))?);

            let (ws, _resp) = match tokio_tungstenite::connect_async(req).await {
                Ok(pair) => pair,
                Err(e) => {
                    // Surface the real reason: DashScope answers failed
                    // handshakes with an HTTP status + JSON error body
                    // (invalid key, unknown model, workspace endpoint
                    // required, ...). Plain Display would swallow it.
                    use tokio_tungstenite::tungstenite::Error as WsErr;
                    let http_detail = match &e {
                        WsErr::Http(resp) => {
                            let body = resp
                                .body()
                                .as_ref()
                                .map(|b| String::from_utf8_lossy(b).trim().to_string())
                                .unwrap_or_default();
                            Some(format!("HTTP {} {}", resp.status().as_u16(), body))
                        }
                        _ => None,
                    };
                    if let Some(detail) = http_detail {
                        return Err(anyhow!(
                            "连接 Qwen 实时服务被拒绝：{detail}（请检查 API Key 是否有效、模型名是否正确；若 Key 属于百炼业务空间，请在 Base URL 填专属域名）"
                        ));
                    }
                    return Err(anyhow!(e)).with_context(|| conn_ctx);
                }
            };
            info!("connected to qwen realtime");
            let (mut write_half, mut read_half) = ws.split();

            // Configure session. Protocol per the official
            // qwen3.5-livetranslate-flash-realtime docs:
            //   * `translation.language` selects the target language
            //     (default would be "en", so this is mandatory for us).
            //   * `input_audio_transcription` only accepts the dedicated ASR
            //     model name or null; we disable ASR because the overlay
            //     shows the translation stream only.
            //   * server VAD mode: the server detects speech end itself and
            //     auto-commits, so we must feed it a *continuous* audio
            //     stream (the pipeline forwards silence frames too).
            //   * `instructions` is not part of this model's session schema.
            let session = serde_json::json!({
                "type": "session.update",
                "session": {
                    "modalities": ["text"],
                    "sample_rate": 16000,
                    "input_audio_format": "pcm",
                    "input_audio_transcription": null,
                    "turn_detection": { "type": "server_vad" },
                    "translation": { "language": self.cfg.target_lang }
                }
            });
            write_half
                .send(Message::Text(session.to_string().into()))
                .await?;

            // Pump audio in one task, read events in another.
            let sink_for_read = sink.clone();
            let read = {
                let sink = sink_for_read.clone();
                async move {
                    while let Some(msg) = read_half.next().await {
                        let msg = match msg {
                            Ok(m) => m,
                            Err(e) => {
                                warn!(error=%e, "qwen ws read error");
                                break;
                            }
                        };
                        match msg {
                            Message::Text(t) => {
                                if let Ok(ev) = serde_json::from_str::<QwenEvent>(&t) {
                                    handle_event(&ev, &sink);
                                } else {
                                    debug!(payload=%t, "unparsed qwen event");
                                }
                            }
                            Message::Close(c) => {
                                info!(?c, "qwen ws closed by server");
                                break;
                            }
                            Message::Ping(_)
                            | Message::Pong(_)
                            | Message::Binary(_)
                            | Message::Frame(_) => {}
                        }
                    }
                }
            };

            // Audio pump. In server-VAD mode we only append; the server
            // commits the buffer on detected end-of-speech by itself.
            let write = async move {
                while let Some(chunk) = audio_rx.recv().await {
                    if chunk.is_empty() {
                        continue;
                    }
                    let mut bytes = Vec::with_capacity(chunk.len() * 2);
                    for s in &chunk {
                        bytes.extend_from_slice(&s.to_le_bytes());
                    }
                    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
                    let msg = serde_json::json!({
                        "type": "input_audio_buffer.append",
                        "audio": b64,
                    });
                    if write_half.send(Message::Text(msg.to_string().into())).await.is_err() {
                        break;
                    }
                }
                // Flush the tail of the session, then close gracefully.
                let _ = write_half
                    .send(Message::Text(
                        serde_json::json!({"type": "session.finish"}).to_string().into(),
                    ))
                    .await;
                let _ = write_half.close().await;
            };

            tokio::select! {
                _ = read => {}
                _ = write => {}
            }
            Ok(())
        }
    }

    #[derive(Debug, Deserialize)]
    #[serde(tag = "type")]
    enum QwenEvent {
        #[serde(rename = "session.created")]
        SessionCreated {
            session: serde_json::Value,
        },
        #[serde(rename = "session.updated")]
        SessionUpdated {
            session: serde_json::Value,
        },
        /// Streaming translation increment (modalities=["text"]). `text` is
        /// the confirmed text *for this event*; `stash` is speculative tail.
        #[serde(rename = "response.text.text")]
        ResponseTextText {
            #[serde(default)]
            text: String,
            #[serde(default)]
            stash: Option<String>,
            #[serde(default)]
            item_id: Option<String>,
        },
        /// Final complete translation of one utterance.
        #[serde(rename = "response.text.done")]
        ResponseTextDone {
            #[serde(default)]
            text: String,
        },
        /// Source-language ASR stream (only when transcription is enabled).
        #[serde(rename = "conversation.item.input_audio_transcription.completed")]
        Completed {
            transcript: String,
            #[serde(default)]
            item_id: Option<String>,
        },
        #[serde(rename = "error")]
        Error { error: serde_json::Value },
        #[serde(other)]
        Other,
    }

    fn handle_event(ev: &QwenEvent, sink: &SubtitleSink) {
        match ev {
            // NOTE: the sink *appends* partials, so we forward only the
            // confirmed increment. The speculative `stash` is dropped here
            // and restored by `ResponseTextDone` (Final supersedes the
            // partial buffer when it is longer).
            QwenEvent::ResponseTextText { text, .. } => {
                if !text.is_empty() {
                    sink.push(SubtitleEvent::Partial(text.clone()));
                }
            }
            QwenEvent::ResponseTextDone { text } => {
                if !text.is_empty() {
                    sink.push(SubtitleEvent::Final(text.trim().to_string()));
                }
            }
            QwenEvent::Completed { .. } => {
                // ASR is disabled in session.update; ignore defensively.
            }
            QwenEvent::Error { error } => {
                warn!(?error, "qwen error event");
            }
            _ => {}
        }
    }
}

// ---------- OpenAI realtime ----------

pub mod openai {
    use super::*;

    const DEFAULT_ENDPOINT: &str = "wss://api.openai.com/v1/realtime";

    pub struct OpenAiRealtime {
        cfg: LlmConfig,
        endpoint: String,
    }

    impl OpenAiRealtime {
        pub fn new(cfg: LlmConfig) -> Result<Self> {
            let endpoint = cfg
                .endpoint
                .clone()
                .filter(|s| !s.trim().is_empty())
                .unwrap_or_else(|| DEFAULT_ENDPOINT.to_string());
            if cfg.api_key.is_empty() {
                return Err(anyhow!("OpenAI API key is empty"));
            }
            Ok(Self { cfg, endpoint })
        }
    }

    #[async_trait]
    impl LlmProvider for OpenAiRealtime {
        fn name(&self) -> &'static str {
            "openai-realtime"
        }

        async fn run(
            self: Arc<Self>,
            mut audio_rx: tokio::sync::mpsc::Receiver<Vec<i16>>,
            sink: SubtitleSink,
        ) -> Result<()> {
            let url = format!("{}?model={}", self.endpoint, self.cfg.model);
            let mut req = url.into_client_request()?;
            req.headers_mut().insert(
                "Authorization",
                http::HeaderValue::from_str(&format!("Bearer {}", self.cfg.api_key))?,
            );
            req.headers_mut()
                .insert("OpenAI-Beta", http::HeaderValue::from_static("realtime=v1"));

            let (ws, _) = tokio_tungstenite::connect_async(req).await?;
            let (mut write_half, mut read_half) = ws.split();
            write_half.send(Message::Text(
                serde_json::json!({
                    "type": "session.update",
                    "session": {
                        "modalities": ["text"],
                        "input_audio_format": "pcm16",
                        "turn_detection": null,
                        "instructions": self.cfg.system_prompt.clone().unwrap_or_else(|| {
                            "You are a real-time simultaneous interpreter. \
                             If the spoken language is Chinese, output the original. \
                             For all other languages, translate the speech into Chinese. \
                             Output only the final subtitle text, no explanations."
                                .to_string()
                        })
                    }
                })
                .to_string()
                .into(),
            ))
            .await?;

            let read = {
                let sink = sink.clone();
                async move {
                    while let Some(msg) = read_half.next().await {
                        let Ok(msg) = msg else { break };
                        if let Message::Text(t) = msg {
                            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&t) {
                                match v.get("type").and_then(|s| s.as_str()).unwrap_or("") {
                                    "conversation.item.input_audio_transcription.delta" => {
                                        if let Some(d) = v.get("delta").and_then(|s| s.as_str()) {
                                            sink.push(SubtitleEvent::Partial(d.to_string()));
                                        }
                                    }
                                    "conversation.item.input_audio_transcription.completed" => {
                                        if let Some(d) = v.get("transcript").and_then(|s| s.as_str()) {
                                            sink.push(SubtitleEvent::Final(d.to_string()));
                                        }
                                    }
                                    "response.text.delta" => {
                                        if let Some(d) = v.get("delta").and_then(|s| s.as_str()) {
                                            sink.push(SubtitleEvent::Partial(d.to_string()));
                                        }
                                    }
                                    "response.text.done" => {
                                        if let Some(d) = v.get("text").and_then(|s| s.as_str()) {
                                            sink.push(SubtitleEvent::Final(d.to_string()));
                                        }
                                    }
                                    "error" => {
                                        warn!(payload=%t, "openai error event");
                                    }
                                    _ => {}
                                }
                            }
                        }
                    }
                }
            };

            let write = async move {
                while let Some(chunk) = audio_rx.recv().await {
                    let mut bytes = Vec::with_capacity(chunk.len() * 2);
                    for s in &chunk {
                        bytes.extend_from_slice(&s.to_le_bytes());
                    }
                    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
                    let msg = serde_json::json!({
                        "type": "input_audio_buffer.append",
                        "audio": b64,
                    });
                    if write_half.send(Message::Text(msg.to_string().into())).await.is_err() {
                        break;
                    }
                }
            };

            tokio::select! {
                _ = read => {}
                _ = write => {}
            }
            Ok(())
        }
    }
}

// ---------- Mock ----------

pub mod mock {
    use super::*;
    use tokio::time::{sleep, Duration};

    pub struct MockProvider {
        cfg: LlmConfig,
    }
    impl MockProvider {
        pub fn new(cfg: LlmConfig) -> Result<Self> {
            Ok(Self { cfg })
        }
    }
    #[async_trait]
    impl LlmProvider for MockProvider {
        fn name(&self) -> &'static str {
            "mock"
        }
        async fn run(
            self: Arc<Self>,
            mut audio_rx: tokio::sync::mpsc::Receiver<Vec<i16>>,
            sink: SubtitleSink,
        ) -> Result<()> {
            let phrases = [
                ("Hello everyone, welcome to the stream.", "大家好，欢迎来到直播间。"),
                ("Today we are testing the real-time subtitle plugin.", "今天我们正在测试实时字幕插件。"),
                ("If you can see this, everything is working.", "如果你能看到这行字，说明一切正常工作。"),
                ("Now switching to English. Please listen carefully.", "现在切换到英文，请仔细听。"),
                ("本句是中文，应当原样输出。", "本句是中文，应当原样输出。"),
            ];
            let mut i = 0;
            while audio_rx.recv().await.is_some() {
                let (src, zh) = &phrases[i % phrases.len()];
                let _ = src; // unused; mock is bilingual-aware but we always emit zh
                sink.push(SubtitleEvent::Partial(zh.to_string()));
                sleep(Duration::from_millis(900)).await;
                sink.push(SubtitleEvent::Final(zh.to_string()));
                i += 1;
                let _ = &self.cfg;
            }
            Ok(())
        }
    }
}

// ---------- Helpers shared by providers ----------

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
pub struct ProviderCapabilities {
    pub supports_streaming_transcript: bool,
    pub sample_rate: u32,
}
