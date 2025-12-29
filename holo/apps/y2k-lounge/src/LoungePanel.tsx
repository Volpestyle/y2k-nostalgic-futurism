import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { VisualizerApp } from "@holo/visualizer-three";
import {
  Badge,
  Button,
  Checkbox,
  Group,
  GroupTitle,
  Hint,
  Input,
  Label,
  Panel,
  PanelHeader,
  PanelSubtitle,
  PanelTitle,
  Range,
  Select,
  Status
} from "@holo/ui-kit";

type ParamSchemaItem = {
  path: string;
  type: "number" | "boolean" | "color" | "select";
  label?: string;
  group?: string;
  min?: number;
  max?: number;
  step?: number;
  options?: Array<string | number>;
};

type PresetOption = { id: string; label: string };

type AudioSource = "file" | "mic" | "none";

type LoungePanelProps = {
  visualizer: VisualizerApp | null;
};

const getByPath = (obj: Record<string, any> | null, path: string) => {
  if (!obj) return undefined;
  return path.split(".").reduce((acc, key) => (acc ? acc[key] : undefined), obj as any);
};

const formatNumber = (value: number) => {
  if (Number.isInteger(value)) return value.toString();
  return value.toFixed(2);
};

const visualizerGroupForPreset = (presetId: string | null) => {
  switch (presetId) {
    case "neonRings":
      return "Neon Rings";
    case "chromeGrid":
      return "Chrome Grid";
    case "particles":
      return "Particles";
    default:
      return null;
  }
};

export function LoungePanel({ visualizer }: LoungePanelProps) {
  const micStreamRef = useRef<MediaStream | null>(null);
  const audioConnectedRef = useRef(false);

  const [params, setParams] = useState<Record<string, any> | null>(null);
  const [schema, setSchema] = useState<ParamSchemaItem[]>([]);
  const [presets, setPresets] = useState<PresetOption[]>([]);
  const [presetId, setPresetId] = useState<string | null>(null);
  const [audioEl, setAudioEl] = useState<HTMLAudioElement | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [trackName, setTrackName] = useState("No track loaded");
  const [isPlaying, setIsPlaying] = useState(false);
  const [audioSource, setAudioSource] = useState<AudioSource>("none");

  const handleAudioRef = useCallback((node: HTMLAudioElement | null) => {
    setAudioEl(node);
  }, []);

  useEffect(() => {
    if (!visualizer) return;

    setParams(visualizer.getParams());
    setSchema(visualizer.getParamSchema() as ParamSchemaItem[]);
    setPresets(visualizer.getPresets());
    setPresetId(visualizer.getParams().preset ?? null);

    const unsubscribeParams = visualizer.on("params", ({ params: nextParams }) => {
      setParams(nextParams as Record<string, any>);
    });
    const unsubscribePreset = visualizer.on("preset", ({ id }) => {
      setPresetId(id);
      setParams(visualizer.getParams() as Record<string, any>);
    });

    return () => {
      unsubscribeParams?.();
      unsubscribePreset?.();
    };
  }, [visualizer]);

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
    };
  }, [audioUrl]);

  const activePresetGroup = visualizerGroupForPreset(presetId);
  const groupedSchema = useMemo(() => {
    const groups: Record<string, ParamSchemaItem[]> = {};
    const order: string[] = [];

    schema.forEach((item) => {
      const groupName = item.group || "Params";
      const isVisualizerGroup =
        groupName === "Neon Rings" || groupName === "Chrome Grid" || groupName === "Particles";
      if (isVisualizerGroup && activePresetGroup && groupName !== activePresetGroup) return;

      if (!groups[groupName]) {
        groups[groupName] = [];
        order.push(groupName);
      }
      groups[groupName].push(item);
    });

    return order.map((name) => ({ name, items: groups[name] }));
  }, [schema, activePresetGroup]);

  const ensureAudioConnected = useCallback(async () => {
    if (!visualizer || !audioEl || audioConnectedRef.current) return;
    await visualizer.setAudioElement(audioEl);
    audioConnectedRef.current = true;
  }, [audioEl, visualizer]);

  const handleAudioFile = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (!file) return;

      if (audioUrl) URL.revokeObjectURL(audioUrl);
      const nextUrl = URL.createObjectURL(file);
      setAudioUrl(nextUrl);
      setTrackName(file.name.replace(/\.[^/.]+$/, ""));
      setIsPlaying(false);
      setAudioSource("file");

      if (micStreamRef.current) {
        micStreamRef.current.getTracks().forEach((track) => track.stop());
        micStreamRef.current = null;
        audioConnectedRef.current = false;
      }
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

  const updateParam = useCallback(
    (item: ParamSchemaItem, value: any) => {
      visualizer?.setParam(item.path, value);
    },
    [visualizer]
  );

  const handlePresetChange = useCallback(
    (event: React.ChangeEvent<HTMLSelectElement>) => {
      const value = event.target.value;
      visualizer?.setPreset(value);
    },
    [visualizer]
  );

  const renderControl = (item: ParamSchemaItem) => {
    const value = getByPath(params, item.path);

    if (item.type === "boolean") {
      return (
        <Label key={item.path} className="ui-toggle">
          <Checkbox
            checked={Boolean(value)}
            onChange={(event) => updateParam(item, event.target.checked)}
          />
          <span>{item.label ?? item.path}</span>
        </Label>
      );
    }

    if (item.type === "select") {
      const options = item.options ?? [];
      const numericOptions = options.every((option) => typeof option === "number");
      const selectedValue =
        value !== undefined ? String(value) : options.length > 0 ? String(options[0]) : "";
      return (
        <Label key={item.path}>
          {item.label ?? item.path}
          <Select
            value={selectedValue}
            onChange={(event) => {
              const nextValue = numericOptions ? Number(event.target.value) : event.target.value;
              updateParam(item, nextValue);
            }}
          >
            {options.map((option) => (
              <option key={String(option)} value={String(option)}>
                {option}
              </option>
            ))}
          </Select>
        </Label>
      );
    }

    if (item.type === "color") {
      return (
        <Label key={item.path}>
          {item.label ?? item.path}
          <Input
            type="color"
            value={typeof value === "string" ? value : "#ffffff"}
            onChange={(event) => updateParam(item, event.target.value)}
          />
        </Label>
      );
    }

    const numericValue = typeof value === "number" ? value : item.min ?? 0;
    return (
      <Label key={item.path} className="ui-slider">
        {item.label ?? item.path}
        <Range
          min={item.min}
          max={item.max}
          step={item.step}
          value={numericValue}
          onChange={(event) => updateParam(item, Number(event.target.value))}
        />
        <span>{formatNumber(numericValue)}</span>
      </Label>
    );
  };

  if (!visualizer) {
    return (
      <Panel className="hudPanel">
        <PanelTitle>Audio lounge</PanelTitle>
        <Status>Booting the visualizer rig...</Status>
      </Panel>
    );
  }

  return (
    <Panel className="hudPanel">
      <PanelHeader className="hudPanelHeader">
        <div>
          <PanelTitle>Audio lounge</PanelTitle>
          <PanelSubtitle>Drive the scene with audio and presets.</PanelSubtitle>
        </div>
        <Badge className="hudBadge">{trackName}</Badge>
      </PanelHeader>

      <Group>
        <GroupTitle>Audio</GroupTitle>
        <Label>
          Load track
          <Input type="file" accept="audio/*" onChange={handleAudioFile} />
        </Label>
        <div className="hudControlRow">
          <Button onClick={togglePlay} disabled={!audioUrl || audioSource === "mic"}>
            {isPlaying ? "Pause" : "Play"}
          </Button>
          <Button onClick={stopAudio} disabled={!audioUrl || audioSource === "mic"} variant="ghost">
            Stop
          </Button>
          <Button onClick={toggleMic} variant="ghost">
            {audioSource === "mic" ? "Mic on" : "Mic"}
          </Button>
        </div>
        <Hint>Pick a file or enable mic input to drive the scene.</Hint>
        <Status>
          Source: {audioSource === "file" ? "File" : audioSource === "mic" ? "Mic" : "None"}
        </Status>
        <audio ref={handleAudioRef} src={audioUrl || undefined} preload="auto" loop />
      </Group>

      <Group>
        <GroupTitle>Preset</GroupTitle>
        <Label>
          Visualizer
          <Select value={presetId ?? ""} onChange={handlePresetChange}>
            {presets.map((preset) => (
              <option key={preset.id} value={preset.id}>
                {preset.label}
              </option>
            ))}
          </Select>
        </Label>
        <Hint>Switch between neon rings, chrome grid, and particles.</Hint>
      </Group>

      {groupedSchema.map((group) => (
        <Group key={group.name}>
          <GroupTitle>{group.name}</GroupTitle>
          {group.items.map((item) => renderControl(item))}
        </Group>
      ))}
    </Panel>
  );
}
