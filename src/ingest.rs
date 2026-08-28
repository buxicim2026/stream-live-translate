//! OBS plugin audio ingest.
//!
//! When the engine runs inside the OBS plugin package, audio does not come
//! from cpal loopback: the C shell plugin attaches an audio filter to the
//! user's OBS source and streams the captured PCM to us over a local TCP
//! connection.
//!
//! Wire protocol (all integers little-endian):
//!
//! ```text
//!   4 bytes   magic "SLTA"
//!   u32       sample rate of the payload (the plugin always sends 16000)
//!   u32       format: 0 = mono s16le
//!   ...       continuous mono s16le PCM samples
//! ```
//!
//! Received audio is resampled to the configured pipeline rate, chopped into
//! ~20 ms frames and pushed into the same channel the cpal capturer uses, so
//! VAD / music detection / LLM downstream are completely unchanged.

use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use parking_lot::Mutex;
use tokio::io::AsyncReadExt;
use tokio::net::{TcpListener, TcpStream};
use tracing::{debug, info, warn};

use crate::audio::PcmSender;
use crate::AppState;

const MAGIC: &[u8; 4] = b"SLTA";
const FORMAT_I16_MONO: u32 = 0;
/// One pipeline frame: 20 ms at 16 kHz.
const FRAME_SAMPLES_16K: usize = 320;

static SENDER: Mutex<Option<PcmSender>> = Mutex::new(None);

/// Guard returned by [`register`]; unregisters the sender when dropped.
pub struct Registration {
    _private: (),
}

impl Drop for Registration {
    fn drop(&mut self) {
        *SENDER.lock() = None;
    }
}

/// Register the raw-PCM sender of the currently active pipeline so ingest
/// connections can feed frames into it.
pub fn register(tx: PcmSender) -> Registration {
    *SENDER.lock() = Some(tx);
    Registration { _private: () }
}

fn try_send_frame(frame: Vec<i16>) {
    if let Some(tx) = SENDER.lock().as_ref() {
        // Best-effort send; drop on backpressure (same policy as cpal path).
        let _ = tx.try_send(frame);
    }
}

/// Run the ingest TCP server. Re-binds automatically when the configured
/// port changes.
pub async fn serve(state: Arc<AppState>) {
    loop {
        let port = state.config.read().audio.ingest_port;
        if port == 0 {
            // Ingest disabled; poll for config changes.
            tokio::time::sleep(Duration::from_secs(5)).await;
            continue;
        }
        match TcpListener::bind(("127.0.0.1", port)).await {
            Ok(listener) => {
                info!(port, "OBS audio ingest listening on 127.0.0.1");
                run_listener(&state, listener, port).await;
            }
            Err(e) => {
                warn!(port, error = %e, "failed to bind ingest port");
                tokio::time::sleep(Duration::from_secs(5)).await;
            }
        }
    }
}

async fn run_listener(state: &Arc<AppState>, listener: TcpListener, port: u16) {
    loop {
        tokio::select! {
            accept = listener.accept() => match accept {
                Ok((stream, _peer)) => {
                    let state = state.clone();
                    tokio::spawn(async move {
                        if let Err(e) = handle_conn(state, stream).await {
                            debug!(error = %e, "ingest connection ended");
                        }
                    });
                }
                Err(e) => {
                    warn!(error = %e, "ingest accept failed");
                }
            },
            _ = watch_port_change(state, port) => {
                info!(port, "ingest port changed, re-binding");
                return;
            }
        }
    }
}

async fn watch_port_change(state: &Arc<AppState>, port: u16) {
    let mut ticker = tokio::time::interval(Duration::from_secs(2));
    loop {
        ticker.tick().await;
        if state.config.read().audio.ingest_port != port {
            return;
        }
    }
}

async fn handle_conn(state: Arc<AppState>, mut stream: TcpStream) -> Result<()> {
    let _ = stream.set_nodelay(true);
    stream
        .writable()
        .await
        .context("ingest socket not writable")?;

    // --- fixed header -------------------------------------------------
    let mut header = [0u8; 12];
    stream
        .read_exact(&mut header)
        .await
        .context("read ingest header")?;
    if &header[0..4] != MAGIC {
        return Err(anyhow!("bad ingest magic"));
    }
    let in_rate = u32::from_le_bytes(header[4..8].try_into().unwrap());
    let format = u32::from_le_bytes(header[8..12].try_into().unwrap());
    if format != FORMAT_I16_MONO {
        return Err(anyhow!("unsupported ingest format {format}"));
    }
    if !(8_000..=384_000).contains(&in_rate) {
        return Err(anyhow!("implausible ingest sample rate {in_rate}"));
    }

    {
        let mut s = state.status.write();
        s.audio_active = true;
        s.last_error = None;
    }
    info!(rate = in_rate, "OBS filter audio stream connected");

    let result = pump_audio(&state, &mut stream, in_rate).await;
    {
        let mut s = state.status.write();
        s.audio_active = false;
    }
    info!("OBS filter audio stream disconnected");
    result
}

async fn pump_audio(
    state: &Arc<AppState>,
    stream: &mut TcpStream,
    in_rate: u32,
) -> Result<()> {
    let out_rate = {
        let r = state.config.read().audio.sample_rate;
        if r == 0 {
            16_000
        } else {
            r
        }
    };
    let frame_samples = (out_rate as usize * FRAME_SAMPLES_16K) / 16_000;

    let mut read_buf = vec![0u8; 8 * 1024];
    let mut leftover_byte: Option<u8> = None;
    let mut sample_buf: Vec<i16> = Vec::with_capacity(frame_samples * 4);

    loop {
        let n = stream
            .read(&mut read_buf)
            .await
            .context("ingest read")?;
        if n == 0 {
            break;
        }

        let mut bytes: &[u8] = &read_buf[..n];
        if let Some(prev) = leftover_byte.take() {
            sample_buf.push(i16::from_le_bytes([prev, bytes[0]]));
            bytes = &bytes[1..];
        }
        let pairs = bytes.len() / 2;
        for pair in bytes[..pairs * 2].chunks_exact(2) {
            sample_buf.push(i16::from_le_bytes([pair[0], pair[1]]));
        }
        if bytes.len() % 2 == 1 {
            leftover_byte = Some(*bytes.last().unwrap());
        }

        let ready: Vec<i16> = if in_rate != out_rate {
            let out = crate::audio::resample_mono(&sample_buf, in_rate, out_rate);
            sample_buf.clear();
            out
        } else {
            std::mem::take(&mut sample_buf)
        };

        let mut frames = ready;
        let tail = frames.len() % frame_samples;
        let tail_samples: Vec<i16> = if tail > 0 {
            frames.split_off(frames.len() - tail)
        } else {
            Vec::new()
        };
        for chunk in frames.chunks(frame_samples) {
            try_send_frame(chunk.to_vec());
        }
        sample_buf.extend_from_slice(&tail_samples);
    }
    Ok(())
}