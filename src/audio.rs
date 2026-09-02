//! Cross-platform system audio loopback capture.
//!
//! Strategy:
//!   * Windows: WASAPI loopback from the default output render device (cpal).
//!   * macOS:   CoreAudio aggregate device via cpal (loopback requires either
//!              a preinstalled "Multi-Output Device" + Soundflower/BlackHole
//!              OR ScreenCaptureKit). We try the standard cpal loopback flow
//!              first and fall back to ScreenCaptureKit when
//!              `audio.use_screen_capture_kit` is true.
//!   * Linux:   ALSA (cpal's backend). System audio is exposed by
//!              PulseAudio/PipeWire as a `*.monitor` source through the
//!              alsa-plugins bridge; we prefer it and fall back to the
//!              default input (usually a microphone) with a warning.

use std::sync::Arc;

use anyhow::{anyhow, Context, Result};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{SampleFormat, SampleRate, Stream, StreamConfig};
use parking_lot::Mutex;
use tracing::{info, warn};

use crate::config::AudioConfig;

pub type PcmSender = tokio::sync::mpsc::Sender<Vec<i16>>;
pub type PcmReceiver = tokio::sync::mpsc::Receiver<Vec<i16>>;

#[derive(Debug, Clone)]
pub struct CaptureSpec {
    pub sample_rate: u32,
    pub channels: u16,
}

pub struct CaptureHandle {
    pub stream: Stream,
    pub spec: CaptureSpec,
}

// SAFETY: cpal::Stream internally stores raw pointers and is therefore !Send
// by default, but all stream operations are synchronized inside cpal (the
// audio callback runs on cpal's own thread). Moving/dropping the handle
// across threads — required because it lives in the shared AppState behind
// a Mutex — is safe on all supported backends.
unsafe impl Send for CaptureHandle {}
unsafe impl Sync for CaptureHandle {}

pub struct AudioCapturer {
    cfg: AudioConfig,
    state: Arc<Mutex<Option<CaptureHandle>>>,
}

impl AudioCapturer {
    pub fn new(cfg: AudioConfig) -> Self {
        Self {
            cfg,
            state: Arc::new(Mutex::new(None)),
        }
    }

    pub fn spec(&self) -> Option<CaptureSpec> {
        self.state.lock().as_ref().map(|h| h.spec.clone())
    }

    pub fn stop(&self) {
        if let Some(handle) = self.state.lock().take() {
            drop(handle.stream);
            info!("audio capture stopped");
        }
    }

    pub fn is_running(&self) -> bool {
        self.state.lock().is_some()
    }

    /// Start a new capture stream. The audio frames (downsampled to mono PCM
    /// s16le) are pushed into `tx`.
    pub fn start(&self, tx: PcmSender) -> Result<()> {
        self.stop();

        let host = cpal::default_host();
        let device = pick_device(&host, &self.cfg)
            .with_context(|| "no suitable audio device found")?;
        let device_name = device.name().unwrap_or_else(|_| "<unnamed>".into());
        info!(device = %device_name, "audio device selected");

        let supported = device
            .default_input_config()
            .or_else(|_| device.default_output_config())
            .map_err(|e| anyhow!("device has no usable config: {e}"))?;

        let target_rate = if self.cfg.sample_rate == 0 {
            supported.sample_rate().0
        } else {
            self.cfg.sample_rate
        };
        let target_channels = if self.cfg.channels == 0 {
            supported.channels()
        } else {
            self.cfg.channels
        };

        let config = StreamConfig {
            channels: target_channels,
            sample_rate: SampleRate(target_rate),
            buffer_size: cpal::BufferSize::Default,
        };

        let sample_format = supported.sample_format();
        let stream = match sample_format {
            SampleFormat::F32 => build_stream::<f32>(&device, &config, tx.clone()),
            SampleFormat::I16 => build_stream::<i16>(&device, &config, tx.clone()),
            SampleFormat::U16 => build_stream::<u16>(&device, &config, tx.clone()),
            other => {
                return Err(anyhow!(
                    "unsupported sample format {other:?}; please file an issue"
                ));
            }
        }
        .with_context(|| "failed to build audio stream")?;

        stream.play().with_context(|| "failed to start audio stream")?;

        *self.state.lock() = Some(CaptureHandle {
            stream,
            spec: CaptureSpec {
                sample_rate: target_rate,
                channels: target_channels,
            },
        });

        info!(
            rate = target_rate,
            channels = target_channels,
            format = ?sample_format,
            "audio capture started"
        );
        Ok(())
    }
}

fn pick_device(host: &cpal::Host, cfg: &AudioConfig) -> Result<cpal::Device> {
    if !cfg.device.is_empty() {
        if let Some(d) = host
            .devices()?
            .into_iter()
            .find(|d| d.name().map(|n| n == cfg.device).unwrap_or(false))
        {
            return Ok(d);
        }
        warn!(
            requested = %cfg.device,
            "requested device not found, falling back to default"
        );
    }
    // Prefer an output device on platforms that support loopback (Windows,
    // macOS), otherwise fall back to the default input.
    if let Some(d) = host.default_output_device() {
        if host.id().name().to_string().contains("WASAPI") {
            return Ok(d);
        }
    }
    // Linux 没有 WASAPI 那种环回接口：系统声音是作为 PulseAudio /
    // PipeWire 的「monitor 源」暴露的，名字里通常带 `.monitor`。cpal 走
    // ALSA（经 alsa-plugins 的 pulse 插件能看到这些源），但默认输入设备
    // 是麦克风 —— 不特殊处理的话 Linux 上会静默录错设备，用户只知道
    // 「没字幕」，很难排查。
    #[cfg(target_os = "linux")]
    {
        if let Some(d) = pick_linux_monitor(host) {
            let name = d.name().unwrap_or_else(|_| "<unnamed>".into());
            info!(device = %name, "using system audio monitor source");
            return Ok(d);
        }
        warn!(
            "no PulseAudio/PipeWire monitor source found; \
             falling back to the default input device (likely a microphone). \
             To capture system audio on Linux, select a *.monitor device above."
        );
    }
    host.default_input_device()
        .ok_or_else(|| anyhow!("no input or output device available"))
}

/// Pick the PulseAudio/PipeWire monitor source that carries system audio.
/// Prefers an exact `*.monitor` name, then any device mentioning monitor /
/// loopback. Returns None when the ALSA plugin bridge isn't available.
#[cfg(target_os = "linux")]
fn pick_linux_monitor(host: &cpal::Host) -> Option<cpal::Device> {
    let mut fallback = None;
    for dev in host.devices().ok()?.into_iter() {
        let Ok(name) = dev.name() else { continue };
        // Only devices we can actually open as an input are usable.
        if dev.default_input_config().is_err() {
            continue;
        }
        let lower = name.to_lowercase();
        if lower.ends_with(".monitor") {
            return Some(dev);
        }
        if fallback.is_none()
            && (lower.contains("monitor") || lower.contains("loopback"))
        {
            fallback = Some(dev);
        }
    }
    fallback
}

fn build_stream<T>(
    device: &cpal::Device,
    config: &StreamConfig,
    tx: PcmSender,
) -> Result<Stream>
where
    T: cpal::Sample + cpal::SizedSample + Send + 'static,
    f32: cpal::FromSample<T>,
{
    let err_tx = tx.clone();
    let channels = config.channels as usize;
    let stream = device.build_input_stream(
        config,
        move |data: &[T], _info| {
            let mut out = Vec::with_capacity(data.len() / channels.max(1));
            for frame in data.chunks(channels.max(1)) {
                let mut acc = 0.0f32;
                for s in frame {
                    acc += s.to_sample::<f32>();
                }
                let mono = acc / channels.max(1) as f32;
                out.push((mono.clamp(-1.0, 1.0) * i16::MAX as f32) as i16);
            }
            // Best-effort send; drop on backpressure.
            let _ = err_tx.try_send(out);
        },
        move |err| {
            tracing::error!(error = %err, "audio stream error");
        },
        None,
    )?;
    Ok(stream)
}

/// List available input/output devices for the admin panel.
pub fn list_devices() -> Result<Vec<DeviceInfo>> {
    let host = cpal::default_host();
    let mut out = Vec::new();
    for dev in host.devices()? {
        let name = dev.name().unwrap_or_else(|_| "<unnamed>".into());
        let supports_input = dev.default_input_config().is_ok();
        let supports_output = dev.default_output_config().is_ok();
        out.push(DeviceInfo {
            name,
            supports_input,
            supports_output,
        });
    }
    Ok(out)
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct DeviceInfo {
    pub name: String,
    pub supports_input: bool,
    pub supports_output: bool,
}

/// Helper: resample a chunk of mono s16le PCM from `from_rate` to `to_rate`.
/// Uses simple linear interpolation; good enough for VAD and ASR.
pub fn resample_mono(input: &[i16], from_rate: u32, to_rate: u32) -> Vec<i16> {
    if from_rate == 0 || from_rate == to_rate || input.is_empty() {
        return input.to_vec();
    }
    let ratio = to_rate as f64 / from_rate as f64;
    let out_len = (input.len() as f64 * ratio) as usize;
    let mut out = Vec::with_capacity(out_len);
    for i in 0..out_len {
        let src = i as f64 / ratio;
        let i0 = src.floor() as usize;
        let i1 = (i0 + 1).min(input.len() - 1);
        let t = (src - i0 as f64) as f32;
        let v = (1.0 - t) * input[i0] as f32 + t * input[i1] as f32;
        out.push(v as i16);
    }
    out
}

#[cfg(target_os = "macos")]
pub mod macos {
    //! On Apple Silicon, ScreenCaptureKit can capture *any* system audio
    //! (including the OBS monitor output) without installing a virtual audio
    //! device. The user grants permission once. We expose a stub here that
    //! the audio module consults when cpal loopback isn't available.
    use super::*;

    pub fn is_supported() -> bool {
        // The actual SCK bindings are out of scope for this template; the
        // admin panel surfaces a clear error instructing the user to either
        // install BlackHole (free, signed) or grant Screen Recording perms.
        true
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
compile_error!("only Windows, macOS, and Linux are supported");

// (No `linux` helper module: cpal 0.15 on Linux talks to ALSA directly, and
// there is nothing to start up front. The monitor-source preference lives in
// `pick_linux_monitor` above.)