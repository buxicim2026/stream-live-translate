//! Pipeline: capture audio -> VAD/music filter -> LLM provider.
//!
//! Data flow:
//!
//!   audio_capturer --[raw pcm]--> mpsc raw_rx --vad_filter--> mpsc speech_rx --> LLM
//!
//! The VAD filter is a small task that buffers raw PCM frames, runs an
//! energy + spectral-flatness test, and only forwards speech segments to
//! the LLM.  We also keep a per-frame RMS in a shared ring buffer so the
//! admin panel can render a live "input level" meter.

use std::sync::Arc;
use std::time::Duration;

use anyhow::Result;
use parking_lot::Mutex;
use tokio::sync::mpsc;
use tracing::{info, warn};

use crate::audio::AudioCapturer;
use crate::vad::{SegmentKind, Vad};
use crate::AppState;

const PCM_CHANNEL_CAPACITY: usize = 256;

pub struct PipelineHandle {
    inner: Arc<Mutex<Option<PipelineInner>>>,
    shutdown: tokio::sync::watch::Sender<bool>,
    pub shutdown_rx: tokio::sync::watch::Receiver<bool>,
}

struct PipelineInner {
    _capturer: Option<AudioCapturer>,
    /// Present in `obs_filter` mode; unregisters the ingest sender on drop.
    _ingest_guard: Option<crate::ingest::Registration>,
    _llm_task: tokio::task::JoinHandle<()>,
    _vad_task: tokio::task::JoinHandle<()>,
    _audio_task: tokio::task::JoinHandle<()>,
}

impl Drop for PipelineInner {
    fn drop(&mut self) {
        // Dropping a JoinHandle only detaches the task; without abort() the
        // old LLM/audio tasks (and the open WebSocket session) would leak
        // and keep running across restarts.
        self._llm_task.abort();
        self._audio_task.abort();
        self._vad_task.abort();
    }
}

impl PipelineHandle {
    pub fn new() -> Self {
        let (shutdown, shutdown_rx) = tokio::sync::watch::channel(false);
        Self {
            inner: Arc::new(Mutex::new(None)),
            shutdown,
            shutdown_rx,
        }
    }

    pub fn is_running(&self) -> bool {
        self.inner.lock().is_some()
    }

    /// Stop the current run; the outer run-loop immediately starts a new
    /// pipeline with the (possibly updated) config. Used by /api/restart
    /// and by the config-change watcher.
    pub async fn restart(&self) {
        let mut guard = self.inner.lock();
        if let Some(inner) = guard.take() {
            drop(inner);
        }
    }

    /// Permanent shutdown (process exit). The outer run-loop sees the
    /// shutdown flag and terminates for good.
    pub async fn shutdown(&self) {
        let _ = self.shutdown.send(true);
        self.restart().await;
    }
}

pub fn spawn(state: Arc<AppState>, config_path: std::path::PathBuf) {
    let handle = state.pipeline.clone();
    let state_clone = state.clone();
    tokio::spawn(async move {
        run(state_clone, config_path, handle).await;
    });
}

async fn run(
    state: Arc<AppState>,
    _config_path: std::path::PathBuf,
    handle: Arc<PipelineHandle>,
) {
    let mut backoff = Duration::from_secs(2);
    loop {
        if *handle.shutdown_rx.borrow() {
            return;
        }
        let result = try_start(&state, &handle).await;
        match result {
            Ok(()) => {
                info!("pipeline started cleanly");
                // Clear any stale error from a previous failed attempt so
                // the admin panel shows a healthy state.
                state.status.write().last_error = None;
                backoff = Duration::from_secs(2);
            }
            Err(e) => {
                warn!(error = %e, "pipeline failed");
                {
                    let mut s = state.status.write();
                    // {:#} flattens the full anyhow cause chain so the admin
                    // panel shows e.g. "connect to qwen realtime: HTTP 401".
                    s.last_error = Some(format!("{e:#}"));
                    s.audio_active = false;
                    s.llm_connected = false;
                }
                tokio::time::sleep(backoff).await;
                backoff = (backoff * 2).min(Duration::from_secs(30));
                continue;
            }
        }
        watch(&state, &handle).await;
    }
}

async fn watch(state: &Arc<AppState>, handle: &Arc<PipelineHandle>) {
    let mut last_provider = state.config.read().llm.provider.clone();
    let mut last_audio_mode = state.config.read().audio.mode.clone();
    let mut last_device = state.config.read().audio.device.clone();
    let mut ticker = tokio::time::interval(Duration::from_secs(2));
    loop {
        ticker.tick().await;
        if *handle.shutdown_rx.borrow() {
            return;
        }
        if !handle.is_running() {
            return;
        }
        let cur = state.config.read().clone();
        if cur.llm.provider != last_provider
            || cur.audio.mode != last_audio_mode
            || cur.audio.device != last_device
        {
            info!("config changed, restarting pipeline");
            last_provider = cur.llm.provider.clone();
            last_audio_mode = cur.audio.mode.clone();
            last_device = cur.audio.device.clone();
            handle.restart().await;
            tokio::time::sleep(Duration::from_millis(250)).await;
            return;
        }
    }
}

async fn try_start(state: &Arc<AppState>, handle: &Arc<PipelineHandle>) -> Result<()> {
    let cfg = state.config.read().clone();
    if cfg.llm.api_key.is_empty() {
        anyhow::bail!("API key not set; configure it in the admin panel first");
    }

    let (raw_tx, mut raw_rx) = mpsc::channel::<Vec<i16>>(PCM_CHANNEL_CAPACITY);
    let (speech_tx, speech_rx) = mpsc::channel::<Vec<i16>>(PCM_CHANNEL_CAPACITY);

    let use_obs_filter = cfg.audio.mode == "obs_filter";
    let mut capturer_slot: Option<AudioCapturer> = None;
    let mut ingest_guard: Option<crate::ingest::Registration> = None;
    if use_obs_filter {
        // Audio arrives over the local ingest TCP port from the OBS plugin
        // filter; no cpal capture needed.
        ingest_guard = Some(crate::ingest::register(raw_tx.clone()));
        info!(
            port = cfg.audio.ingest_port,
            "audio input: OBS filter ingest (waiting for the plugin to stream audio)"
        );
    } else {
        let capturer = AudioCapturer::new(cfg.audio.clone());
        capturer
            .start(raw_tx)
            .map_err(|e| anyhow::anyhow!("audio start failed: {e}"))?;
        capturer_slot = Some(capturer);
    }
    if !use_obs_filter {
        let mut s = state.status.write();
        s.audio_active = true;
        s.last_error = None;
    }
    let sink = state.subtitle.sink();

    // VAD filter task.
    let vad_state = state.clone();
    let vad_cfg = cfg.filter.clone();
    let audio_task = tokio::spawn(async move {
        let mut vad = Vad::new(vad_cfg);
        let mut speech_buf: Vec<i16> = Vec::with_capacity(16 * 1024);
        let mut last_kind = SegmentKind::Silence;
        let mut silence_debounce_ms: u32 = 0;
        loop {
            let frame = match raw_rx.recv().await {
                Some(f) => f,
                None => return,
            };
            let spec_rate = vad_state
                .config
                .read()
                .audio
                .sample_rate
                .max(16_000);
            let decision = vad.decide(&frame, spec_rate);
            match decision.kind {
                SegmentKind::Speech => {
                    if matches!(last_kind, SegmentKind::Silence) {
                        speech_buf.clear();
                    }
                    speech_buf.extend_from_slice(&frame);
                    let _ = speech_tx.try_send(frame.clone());
                    last_kind = SegmentKind::Speech;
                }
                SegmentKind::Music => {
                    // Drop the frame; also flush the current buffer.
                    speech_buf.clear();
                    last_kind = SegmentKind::Music;
                }
                SegmentKind::Silence => {
                    // Realtime providers (server VAD) need a *continuous*
                    // audio stream to detect end-of-speech, so forward
                    // silence frames downstream too. Only music is dropped.
                    let _ = speech_tx.try_send(frame.clone());
                    if matches!(last_kind, SegmentKind::Speech) {
                        let frame_ms = (frame.len() as u64 * 1000
                            / spec_rate as u64) as u32;
                        silence_debounce_ms = silence_debounce_ms.saturating_add(frame_ms);
                        if silence_debounce_ms > 350 {
                            // End of segment; the LLM commits on its own.
                            last_kind = SegmentKind::Silence;
                            silence_debounce_ms = 0;
                        }
                    } else {
                        last_kind = SegmentKind::Silence;
                    }
                }
            }
            let _ = speech_buf;
            let _ = &vad_state;
        }
    });

    // LLM task. Owns `speech_rx`.
    let llm_state = state.clone();
    let llm_task = tokio::spawn(async move {
        let provider = match crate::llm::build(&llm_state.config.read().llm) {
            Ok(p) => p,
            Err(e) => {
                let mut s = llm_state.status.write();
                s.last_error = Some(format!("{e:#}"));
                s.llm_connected = false;
                return;
            }
        };
        {
            let mut s = llm_state.status.write();
            s.llm_connected = true;
        }
        match provider.run(speech_rx, sink.clone()).await {
            Ok(_) => {
                let mut s = llm_state.status.write();
                s.llm_connected = false;
            }
            Err(e) => {
                warn!(error = %e, "LLM session ended");
                let mut s = llm_state.status.write();
                s.llm_connected = false;
                s.last_error = Some(format!("{e:#}"));
            }
        }
    });

    *handle.inner.lock() = Some(PipelineInner {
        _capturer: capturer_slot,
        _ingest_guard: ingest_guard,
        _llm_task: llm_task,
        _vad_task: tokio::spawn(async move {}), // legacy placeholder
        _audio_task: audio_task,
    });

    Ok(())
}
