// Video export with WebCodecs + mp4-muxer (no ffmpeg needed).
import { Muxer, ArrayBufferTarget, StreamTarget } from 'mp4-muxer';
import { sample } from './audio.js';
import { renderFrame } from './catalog.js';

function seekVideo(v, t) {
  if (Math.abs(v.currentTime - t) < 0.001) return Promise.resolve();
  return new Promise((res) => {
    const done = () => { v.removeEventListener('seeked', done); res(); };
    v.addEventListener('seeked', done);
    v.currentTime = t;
    setTimeout(done, 2000);
  });
}

async function pickVideoConfig(width, height, fps) {
  const bitrate = Math.round(width * height * fps * 0.12);
  const candidates = [
    { codec: 'avc1.640034', mux: 'avc' },
    { codec: 'avc1.4d0034', mux: 'avc' },
    { codec: 'avc1.42003e', mux: 'avc' },
    { codec: 'vp09.00.51.08', mux: 'vp9' },
    { codec: 'av01.0.12M.08', mux: 'av1' },
  ];
  for (const c of candidates) {
    for (const hw of ['prefer-hardware', 'no-preference']) {
      const cfg = { codec: c.codec, width, height, bitrate, framerate: fps, hardwareAcceleration: hw };
      if (c.mux === 'avc') cfg.avc = { format: 'avc' };
      try {
        const s = await VideoEncoder.isConfigSupported(cfg);
        if (s.supported) return { cfg: s.config, mux: c.mux };
      } catch { /* try next */ }
    }
  }
  throw new Error('NO_VIDEO_CODEC');
}

async function pickAudioConfig(sampleRate, numberOfChannels) {
  for (const c of [{ codec: 'mp4a.40.2', mux: 'aac' }, { codec: 'opus', mux: 'opus' }]) {
    for (const sr of [sampleRate, 48000, 44100]) {
      const cfg = { codec: c.codec, sampleRate: sr, numberOfChannels, bitrate: 192000 };
      try {
        const s = await AudioEncoder.isConfigSupported(cfg);
        if (s.supported) return { cfg: s.config, mux: c.mux };
      } catch { /* next */ }
    }
  }
  return null;
}

// Resample (linear) a channel to the target rate if needed.
function resample(data, from, to) {
  if (from === to) return data;
  const n = Math.floor((data.length * to) / from);
  const out = new Float32Array(n);
  const k = from / to;
  for (let i = 0; i < n; i++) {
    const x = i * k, i0 = Math.floor(x), fr = x - i0;
    out[i] = data[i0] * (1 - fr) + (data[i0 + 1] ?? data[i0]) * fr;
  }
  return out;
}

/**
 * opts: { width, height, fps, start, end, options (visual), analysis, audioBuffer, onProgress, signal }
 * returns Uint8Array of an MP4 file
 */
export async function exportVideo({ width, height, fps, start, end, options, analysis, audioBuffer, onProgress, signal, toDisk }) {
  const v = await pickVideoConfig(width, height, fps);
  const ch = Math.min(2, audioBuffer.numberOfChannels);
  const a = await pickAudioConfig(audioBuffer.sampleRate, ch);

  // Desktop app: stream the file straight to disk so long 4K videos do not sit in memory.
  let target, writes = Promise.resolve();
  if (toDisk) {
    target = new StreamTarget({
      chunked: true,
      chunkSize: 16 * 1024 * 1024,
      onData: (data, position) => { const copy = data.slice(); writes = writes.then(() => toDisk(copy, position)); },
    });
  } else target = new ArrayBufferTarget();
  const muxer = new Muxer({
    target,
    video: { codec: v.mux, width, height, frameRate: fps },
    audio: a ? { codec: a.mux, sampleRate: a.cfg.sampleRate, numberOfChannels: ch } : undefined,
    fastStart: toDisk ? false : 'in-memory',
    firstTimestampBehavior: 'offset',
  });

  let failure = null;
  const venc = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => { failure = e; },
  });
  venc.configure(v.cfg);

  // ---- audio first (fast) ----
  if (a) {
    const aenc = new AudioEncoder({
      output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
      error: (e) => { failure = e; },
    });
    aenc.configure(a.cfg);
    const srIn = audioBuffer.sampleRate, srOut = a.cfg.sampleRate;
    const s0 = Math.floor(start * srIn), s1 = Math.min(audioBuffer.length, Math.floor(end * srIn));
    const chans = [];
    for (let c = 0; c < ch; c++) {
      let d = audioBuffer.getChannelData(c).slice(s0, s1);
      // short fade in/out
      const fi = Math.min(d.length, Math.floor(0.05 * srIn)), fo = Math.min(d.length, Math.floor(1.0 * srIn));
      for (let i = 0; i < fi; i++) d[i] *= i / fi;
      for (let i = 0; i < fo; i++) d[d.length - 1 - i] *= i / fo;
      chans.push(resample(d, srIn, srOut));
    }
    const total = chans[0].length, block = 1024;
    for (let off = 0; off < total; off += block) {
      const n = Math.min(block, total - off);
      const planar = new Float32Array(n * ch);
      for (let c = 0; c < ch; c++) planar.set(chans[c].subarray(off, off + n), c * n);
      const ad = new AudioData({
        format: 'f32-planar', sampleRate: srOut, numberOfFrames: n, numberOfChannels: ch,
        timestamp: Math.round((off / srOut) * 1e6), data: planar,
      });
      aenc.encode(ad);
      ad.close();
    }
    await aenc.flush();
    aenc.close();
  }

  // ---- video ----
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d', { alpha: false });
  const n = Math.round((end - start) * fps);
  const duration = analysis.duration;
  options.bgVideo?.pause();
  for (let i = 0; i < n; i++) {
    if (signal?.aborted) { venc.close(); throw new Error('ABORTED'); }
    if (failure) throw failure;
    const t = start + i / fps;
    if (options.bgType === 'video' && options.bgVideo && options.bgVideo.duration) {
      await seekVideo(options.bgVideo, t % options.bgVideo.duration);
    }
    renderFrame(ctx, width, height, options, sample(analysis, t), duration);
    const frame = new VideoFrame(canvas, { timestamp: Math.round((i / fps) * 1e6), duration: Math.round(1e6 / fps) });
    venc.encode(frame, { keyFrame: i % (fps * 2) === 0 });
    frame.close();
    // keep very few frames in flight: each 4K frame is ~33 MB of video memory
    const maxQueue = width * height > 2.5e6 ? 1 : 3;
    while (venc.encodeQueueSize > maxQueue) await new Promise((r) => setTimeout(r, 4));
    if (toDisk && i % 30 === 0) await writes;
    if (i % 5 === 0) onProgress?.(i / n);
    await new Promise((r) => setTimeout(r, 0)); // let the GPU and UI catch up every frame
  }
  await venc.flush();
  venc.close();
  if (failure) throw failure;
  muxer.finalize();
  await writes;
  onProgress?.(1);
  return { data: toDisk ? null : new Uint8Array(target.buffer), codec: v.mux, audioCodec: a?.mux || null };
}

export async function saveVideo(data, name, title) {
  if (window.desktop) {
    const path = await window.desktop.chooseSavePath(name, title);
    if (!path) return null;
    const CH = 8 * 1024 * 1024;
    for (let off = 0; off < data.length; off += CH) await window.desktop.writeChunk(data.subarray(off, off + CH));
    await window.desktop.finishSave(true);
    return path;
  }
  // inside a claude.ai artifact: the platform's download capability
  const dl = window.claude?.use ? await window.claude.use('downloads').catch(() => null) : null;
  if (dl) {
    try {
      await dl.save({ filename: name, data: new Blob([data], { type: 'video/mp4' }) });
      return name;
    } catch (e) {
      if (e?.code === 'declined') return null;
      throw new Error(e?.message || String(e?.code || e));
    }
  }
  const url = URL.createObjectURL(new Blob([data], { type: 'video/mp4' }));
  const el = document.createElement('a');
  el.href = url; el.download = name; el.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  return name;
}
