//! Soundboard files: every imported sound is decoded once here and stored as a short mono WAV.
//! Before, the web view decoded the original file (up to minutes of stereo audio) and kept the
//! decoded samples in memory for good – a single long MP3 could take hundreds of MB.

use std::{io::Write, path::Path};
use symphonia::core::{
    audio::SampleBuffer,
    codecs::{DecoderOptions, CODEC_TYPE_NULL},
    errors::Error,
    formats::FormatOptions,
    io::MediaSourceStream,
    meta::MetadataOptions,
    probe::Hint,
};

/// Sound effects are cut after this many seconds.
pub const MAX_SECS: f64 = 12.0;
/// Sample rate of the stored file (plenty for effects, a quarter of the memory of 48 kHz stereo).
const OUT_RATE: u32 = 32_000;

/// Decodes `src` (MP3, WAV, OGG, M4A/AAC, FLAC) and writes the first [`MAX_SECS`] seconds to `dest`
/// as 16-bit mono WAV. Returns the length in seconds.
pub fn to_short_wav(src: &Path, dest: &Path) -> Result<f64, String> {
    let file = std::fs::File::open(src).map_err(|_| "File not found".to_string())?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());
    let mut hint = Hint::new();
    if let Some(ext) = src.extension().and_then(|e| e.to_str()) {
        hint.with_extension(ext);
    }
    let probed = symphonia::default::get_probe()
        .format(&hint, mss, &FormatOptions::default(), &MetadataOptions::default())
        .map_err(|e| format!("Unsupported audio file: {e}"))?;
    let mut format = probed.format;
    let (track_id, params) = {
        let t = format
            .tracks()
            .iter()
            .find(|t| t.codec_params.codec != CODEC_TYPE_NULL)
            .ok_or("The file has no audio track")?;
        (t.id, t.codec_params.clone())
    };
    let in_rate = params.sample_rate.unwrap_or(48_000).max(1);
    let mut dec = symphonia::default::get_codecs()
        .make(&params, &DecoderOptions::default())
        .map_err(|e| format!("Unsupported audio codec: {e}"))?;

    let max_in = (in_rate as f64 * MAX_SECS) as usize;
    let mut mono: Vec<f32> = Vec::with_capacity(max_in.min(in_rate as usize * 4));
    while mono.len() < max_in {
        let packet = match format.next_packet() {
            Ok(p) => p,
            Err(Error::IoError(_)) | Err(Error::ResetRequired) => break, // end of the stream
            Err(e) => return Err(format!("Could not read the audio file: {e}")),
        };
        if packet.track_id() != track_id {
            continue;
        }
        let decoded = match dec.decode(&packet) {
            Ok(d) => d,
            Err(Error::DecodeError(_)) | Err(Error::IoError(_)) => continue, // skip a damaged frame
            Err(e) => return Err(format!("Could not decode the audio file: {e}")),
        };
        let spec = *decoded.spec();
        let ch = spec.channels.count().max(1);
        let mut sb = SampleBuffer::<f32>::new(decoded.capacity() as u64, spec);
        sb.copy_interleaved_ref(decoded);
        for frame in sb.samples().chunks(ch) {
            mono.push(frame.iter().sum::<f32>() / ch as f32);
            if mono.len() >= max_in {
                break;
            }
        }
    }
    if mono.is_empty() {
        return Err("The audio file is empty".into());
    }
    let truncated = mono.len() >= max_in;
    let mut out = resample(&mono, in_rate, OUT_RATE);
    drop(mono);
    if truncated {
        // short fade-out instead of a click where the sound is cut
        let n = (OUT_RATE as usize / 20).min(out.len());
        let len = out.len();
        for (k, s) in out[len - n..].iter_mut().enumerate() {
            *s *= 1.0 - k as f32 / n as f32;
        }
    }
    write_wav(dest, &out, OUT_RATE).map_err(|e| e.to_string())?;
    Ok(out.len() as f64 / OUT_RATE as f64)
}

/// Linear resampling – good enough for short effects.
fn resample(input: &[f32], from: u32, to: u32) -> Vec<f32> {
    if from == to || input.len() < 2 {
        return input.to_vec();
    }
    let ratio = from as f64 / to as f64;
    let n = ((input.len() as f64) / ratio).floor() as usize;
    (0..n)
        .map(|i| {
            let pos = i as f64 * ratio;
            let j = pos.floor() as usize;
            let f = (pos - j as f64) as f32;
            let a = input[j.min(input.len() - 1)];
            let b = input[(j + 1).min(input.len() - 1)];
            a + (b - a) * f
        })
        .collect()
}

pub fn write_wav(dest: &Path, samples: &[f32], rate: u32) -> std::io::Result<()> {
    let data_len = (samples.len() * 2) as u32;
    let mut b = Vec::with_capacity(44 + data_len as usize);
    b.extend_from_slice(b"RIFF");
    b.extend_from_slice(&(36 + data_len).to_le_bytes());
    b.extend_from_slice(b"WAVEfmt ");
    b.extend_from_slice(&16u32.to_le_bytes());
    b.extend_from_slice(&1u16.to_le_bytes()); // PCM
    b.extend_from_slice(&1u16.to_le_bytes()); // mono
    b.extend_from_slice(&rate.to_le_bytes());
    b.extend_from_slice(&(rate * 2).to_le_bytes());
    b.extend_from_slice(&2u16.to_le_bytes());
    b.extend_from_slice(&16u16.to_le_bytes());
    b.extend_from_slice(b"data");
    b.extend_from_slice(&data_len.to_le_bytes());
    for s in samples {
        let v = (s.clamp(-1.0, 1.0) * i16::MAX as f32) as i16;
        b.extend_from_slice(&v.to_le_bytes());
    }
    let mut f = std::fs::File::create(dest)?;
    f.write_all(&b)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn long_wav_is_cut_and_downmixed() {
        let dir = std::env::temp_dir().join(format!("nexus-sound-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        // 30 s of a 440 Hz tone at 48 kHz
        let rate = 48_000u32;
        let samples: Vec<f32> = (0..rate as usize * 30)
            .map(|i| (i as f32 * 440.0 * std::f32::consts::TAU / rate as f32).sin() * 0.5)
            .collect();
        let src = dir.join("long.wav");
        write_wav(&src, &samples, rate).unwrap();
        let dest = dir.join("short.wav");
        let secs = to_short_wav(&src, &dest).unwrap();
        assert!((secs - MAX_SECS).abs() < 0.1, "{secs}");
        let size = std::fs::metadata(&dest).unwrap().len();
        assert!(size < 800_000, "{size}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn resample_halves() {
        let v: Vec<f32> = (0..100).map(|i| i as f32).collect();
        let r = resample(&v, 48_000, 24_000);
        assert_eq!(r.len(), 50);
        assert_eq!(r[10], 20.0);
    }
}
