import { useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { formatSpeechTime } from "../speech/transcription";

export type SpeechPlayback = { taskId: string; analyser: AnalyserNode };

export function SpeechWaveform({ analyser }: { analyser: AnalyserNode }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    const data = new Uint8Array(analyser.frequencyBinCount);
    const ratio = window.devicePixelRatio || 1;
    const color = getComputedStyle(canvas).color;
    let frame = 0, last = -33;
    const draw = (now: number) => {
      frame = requestAnimationFrame(draw);
      if (now - last < 33) return;
      last = now;
      const width = Math.max(1, Math.round(canvas.clientWidth * ratio));
      const height = Math.max(1, Math.round(canvas.clientHeight * ratio));
      if (canvas.width !== width) canvas.width = width;
      if (canvas.height !== height) canvas.height = height;
      analyser.getByteFrequencyData(data);
      context.clearRect(0, 0, width, height);
      context.fillStyle = color;
      const count = 48, step = width / count, barWidth = Math.max(ratio, step - 2 * ratio);
      for (let index = 0; index < count; index++) {
        const level = data[Math.floor(index * data.length / count)] / 255;
        const barHeight = Math.max(2 * ratio, Math.pow(level, 0.7) * (height - 2 * ratio));
        context.beginPath();
        context.roundRect(index * step, (height - barHeight) / 2, barWidth, barHeight, barWidth / 2);
        context.fill();
      }
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [analyser]);
  return <canvas ref={ref} className="speech-waveform" role="img" aria-label="试听音频实时频谱" />;
}

export function SpeechAudioPlayer({ taskId, path, positions: savedPositions, onPlaybackChange }: { taskId: string; path: string; positions?: Map<string, number>; onPlaybackChange?: (playback: SpeechPlayback | null) => void }) {
  const audio = useRef<HTMLAudioElement>(null);
  const graph = useRef<{ context: AudioContext; analyser: AnalyserNode } | null>(null);
  const ownPositions = useRef(new Map<string, number>());
  const positions = savedPositions ?? ownPositions.current;
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(() => Number(localStorage.getItem("llmchat-speech-volume") ?? "1"));
  const [volumeOpen, setVolumeOpen] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const element = audio.current;
    setPosition(positions.get(taskId) ?? 0); setPlaying(false); setDuration(0); setError("");
    return () => {
      if (element) {
        if (element.readyState >= 1) positions.set(taskId, element.currentTime);
        element.pause();
      }
      onPlaybackChange?.(null);
    };
  }, [taskId, path, positions, onPlaybackChange]);
  useEffect(() => () => { const context = graph.current?.context; graph.current = null; void context?.close(); }, []);
  useEffect(() => { if (audio.current) audio.current.volume = volume; localStorage.setItem("llmchat-speech-volume", String(volume)); }, [volume, path]);
  const savePosition = () => { const element = audio.current; if (element && element.readyState >= 1) positions.set(taskId, element.currentTime); };
  const loadPosition = () => {
    const element = audio.current;
    if (!element) return;
    const duration = element.duration || 0;
    const position = Math.min(positions.get(taskId) ?? 0, duration);
    element.currentTime = position;
    setDuration(duration); setPosition(position);
  };
  const stopPlayback = () => { savePosition(); setPlaying(false); onPlaybackChange?.(null); void graph.current?.context.suspend(); };
  const togglePlayback = async () => {
    const element = audio.current;
    if (!element) return;
    if (playing) { element.pause(); return; }
    try {
      if (!graph.current) {
        const context = new AudioContext();
        const analyser = context.createAnalyser();
        analyser.fftSize = 256; analyser.smoothingTimeConstant = 0.75;
        context.createMediaElementSource(element).connect(analyser);
        analyser.connect(context.destination);
        graph.current = { context, analyser };
      }
      await graph.current.context.resume();
      await element.play();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  const time = (seconds: number) => formatSpeechTime(seconds, ".").slice(0, -4);
  return <div className="speech-player">
    <audio ref={audio} crossOrigin="anonymous" src={convertFileSrc(path)} preload="metadata" onLoadedMetadata={loadPosition}
      onTimeUpdate={() => { savePosition(); setPosition(audio.current?.currentTime || 0); }} onPlay={() => { setPlaying(true); if (graph.current) onPlaybackChange?.({ taskId, analyser: graph.current.analyser }); }} onPause={stopPlayback} onEnded={stopPlayback} onError={() => { stopPlayback(); setError("此音频无法直接试听，仍可尝试分段识别。"); }} />
    <button type="button" aria-label={playing ? "暂停试听" : "播放音频"} onClick={() => void togglePlayback()}>{playing ? "Ⅱ" : "▶"}</button>
    <span className="speech-player-time">{time(position)} / {time(duration)}</span>
    <input className="speech-player-seek" aria-label="播放位置" type="range" min="0" max={duration || 0} step="0.1" value={position} onChange={event => { const value = Number(event.target.value); if (audio.current) audio.current.currentTime = value; positions.set(taskId, value); setPosition(value); }} />
    <div className={`speech-volume${volumeOpen ? " is-open" : ""}`} onPointerEnter={() => setVolumeOpen(true)} onPointerLeave={() => setVolumeOpen(false)} onFocus={() => setVolumeOpen(true)} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setVolumeOpen(false); }}>
      <button type="button" aria-label="调整音量" aria-expanded={volumeOpen} onClick={() => setVolumeOpen(true)}>
        <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden><path fill="currentColor" d="M3 9v6h4l5 4V5L7 9H3z"/><path d="M16 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14" fill="none" stroke="currentColor" strokeWidth="2"/></svg>
      </button>
      <div className="speech-volume-popup"><input type="range" aria-label="音量" aria-orientation="vertical" min="0" max="1" step="0.01" value={volume} onChange={event => setVolume(Number(event.target.value))} /><span>{Math.round(volume * 100)}%</span></div>
    </div>
    {error && <small className="speech-player-error">{error}</small>}
  </div>;
}
