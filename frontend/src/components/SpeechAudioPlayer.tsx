import { useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { formatSpeechTime } from "../speech/transcription";

export function SpeechAudioPlayer({ path }: { path: string }) {
  const audio = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(() => Number(localStorage.getItem("llmchat-speech-volume") ?? "1"));
  const [volumeOpen, setVolumeOpen] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    setPosition(0); setPlaying(false); setDuration(0); setError("");
    return () => { audio.current?.pause(); };
  }, [path]);
  useEffect(() => { if (audio.current) audio.current.volume = volume; localStorage.setItem("llmchat-speech-volume", String(volume)); }, [volume, path]);
  const time = (seconds: number) => formatSpeechTime(seconds, ".").slice(0, -4);
  return <div className="speech-player">
    <audio ref={audio} src={convertFileSrc(path)} preload="metadata" onLoadedMetadata={() => setDuration(audio.current?.duration || 0)}
      onTimeUpdate={() => setPosition(audio.current?.currentTime || 0)} onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)} onError={() => setError("此音频无法直接试听，仍可尝试分段识别。")} />
    <button type="button" aria-label={playing ? "暂停试听" : "播放音频"} onClick={() => { const element = audio.current; if (!element) return; if (playing) element.pause(); else void element.play().catch(cause => setError(cause.message)); }}>{playing ? "Ⅱ" : "▶"}</button>
    <span className="speech-player-time">{time(position)} / {time(duration)}</span>
    <input className="speech-player-seek" aria-label="播放位置" type="range" min="0" max={duration || 0} step="0.1" value={position} onChange={event => { const value = Number(event.target.value); if (audio.current) audio.current.currentTime = value; setPosition(value); }} />
    <div className={`speech-volume${volumeOpen ? " is-open" : ""}`} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setVolumeOpen(false); }}>
      <button type="button" aria-label="调整音量" aria-expanded={volumeOpen} onClick={() => setVolumeOpen(open => !open)}>
        <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden><path fill="currentColor" d="M3 9v6h4l5 4V5L7 9H3z"/><path d="M16 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14" fill="none" stroke="currentColor" strokeWidth="2"/></svg>
      </button>
      <div className="speech-volume-popup"><input type="range" aria-label="音量" aria-orientation="vertical" min="0" max="1" step="0.01" value={volume} onChange={event => setVolume(Number(event.target.value))} /><span>{Math.round(volume * 100)}%</span></div>
    </div>
    {error && <small className="speech-player-error">{error}</small>}
  </div>;
}
