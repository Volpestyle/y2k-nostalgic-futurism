import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { VisualizerApp } from "@holo/visualizer-three";

type AudioSource = "file" | "mic" | "none";

type AudioLoungeContextValue = {
  audioUrl: string | null;
  trackName: string;
  isPlaying: boolean;
  audioSource: AudioSource;
  loadAudioFile: (file: File) => void;
  togglePlay: () => Promise<void>;
  stopAudio: () => void;
  toggleMic: () => Promise<void>;
};

const AudioLoungeContext = createContext<AudioLoungeContextValue | null>(null);

export function AudioLoungeProvider({
  visualizer,
  children
}: {
  visualizer: VisualizerApp | null;
  children: React.ReactNode;
}) {
  const micStreamRef = useRef<MediaStream | null>(null);
  const audioConnectedRef = useRef(false);

  const [audioEl, setAudioEl] = useState<HTMLAudioElement | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [trackName, setTrackName] = useState("No track loaded");
  const [isPlaying, setIsPlaying] = useState(false);
  const [audioSource, setAudioSource] = useState<AudioSource>("none");

  const handleAudioRef = useCallback((node: HTMLAudioElement | null) => {
    setAudioEl(node);
  }, []);

  useEffect(() => {
    if (!audioEl) return undefined;

    const handlePlay = () => setIsPlaying(true);
    const handlePause = () => setIsPlaying(false);
    audioEl.addEventListener("play", handlePlay);
    audioEl.addEventListener("pause", handlePause);
    audioEl.addEventListener("ended", handlePause);

    return () => {
      audioEl.removeEventListener("play", handlePlay);
      audioEl.removeEventListener("pause", handlePause);
      audioEl.removeEventListener("ended", handlePause);
    };
  }, [audioEl]);

  useEffect(() => {
    return () => {
      if (audioUrl) URL.revokeObjectURL(audioUrl);
      if (micStreamRef.current) {
        micStreamRef.current.getTracks().forEach((track) => track.stop());
        micStreamRef.current = null;
      }
    };
  }, [audioUrl]);

  useEffect(() => {
    audioConnectedRef.current = false;
  }, [visualizer]);

  const ensureAudioConnected = useCallback(async () => {
    if (!visualizer || !audioEl || audioConnectedRef.current) return;
    await visualizer.setAudioElement(audioEl);
    audioConnectedRef.current = true;
  }, [audioEl, visualizer]);

  const loadAudioFile = useCallback(
    (file: File) => {
      if (audioUrl) URL.revokeObjectURL(audioUrl);
      const nextUrl = URL.createObjectURL(file);
      setAudioUrl(nextUrl);
      setTrackName(file.name.replace(/\.[^/.]+$/, ""));
      setIsPlaying(false);
      setAudioSource("file");

      if (micStreamRef.current) {
        micStreamRef.current.getTracks().forEach((track) => track.stop());
        micStreamRef.current = null;
      }

      audioConnectedRef.current = false;
    },
    [audioUrl]
  );

  const togglePlay = useCallback(async () => {
    if (!audioEl) return;
    await ensureAudioConnected();

    if (audioEl.paused) {
      await audioEl.play();
    } else {
      audioEl.pause();
    }
  }, [audioEl, ensureAudioConnected]);

  const stopAudio = useCallback(() => {
    if (!audioEl) return;
    audioEl.pause();
    audioEl.currentTime = 0;
  }, [audioEl]);

  const toggleMic = useCallback(async () => {
    if (!visualizer) return;

    if (micStreamRef.current) {
      micStreamRef.current.getTracks().forEach((track) => track.stop());
      micStreamRef.current = null;
      audioConnectedRef.current = false;
      setIsPlaying(Boolean(audioEl && !audioEl.paused));
      setAudioSource(audioUrl ? "file" : "none");
      return;
    }

    try {
      if (audioEl) {
        audioEl.pause();
      }
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      await visualizer.setMicStream(stream);
      micStreamRef.current = stream;
      audioConnectedRef.current = false;
      setAudioSource("mic");
      setIsPlaying(true);
    } catch (error) {
      console.error(error);
    }
  }, [audioEl, audioUrl, visualizer]);

  const value = useMemo(
    () => ({
      audioUrl,
      trackName,
      isPlaying,
      audioSource,
      loadAudioFile,
      togglePlay,
      stopAudio,
      toggleMic
    }),
    [
      audioUrl,
      trackName,
      isPlaying,
      audioSource,
      loadAudioFile,
      togglePlay,
      stopAudio,
      toggleMic
    ]
  );

  return (
    <AudioLoungeContext.Provider value={value}>
      {children}
      <audio ref={handleAudioRef} src={audioUrl || undefined} preload="auto" loop />
    </AudioLoungeContext.Provider>
  );
}

export function useAudioLounge() {
  const context = useContext(AudioLoungeContext);
  if (!context) {
    throw new Error("useAudioLounge must be used within an AudioLoungeProvider");
  }
  return context;
}

export type { AudioSource };
