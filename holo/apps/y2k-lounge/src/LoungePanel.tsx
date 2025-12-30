import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { defaultParams, presets as visualizerPresets } from "@holo/visualizer-three";
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
import { AudioControls } from "./AudioControls";
import { useAudioLounge } from "./AudioLoungeContext";

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

type LoungePanelProps = {
  visualizer: VisualizerApp | null;
};

type VisualizerStorage = {
  activePreset?: string;
  presets?: Record<string, Record<string, any>>;
};

const VISUALIZER_STORAGE_KEY = "y2k-lounge.visualizer-settings";

const readVisualizerStorage = (): VisualizerStorage => {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(VISUALIZER_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    return parsed as VisualizerStorage;
  } catch {
    return {};
  }
};

const writeVisualizerStorage = (payload: VisualizerStorage) => {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(VISUALIZER_STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // ignore storage write errors
  }
};

const deepClone = <T,>(value: T): T => {
  const clone = (globalThis as { structuredClone?: (input: T) => T }).structuredClone;
  if (typeof clone === "function") {
    return clone(value);
  }
  return JSON.parse(JSON.stringify(value));
};

const deepMerge = (target: Record<string, any>, patch: Record<string, any>) => {
  Object.entries(patch || {}).forEach(([key, value]) => {
    if (Array.isArray(value)) {
      target[key] = value.slice();
      return;
    }
    if (value && typeof value === "object") {
      if (!target[key] || typeof target[key] !== "object") target[key] = {};
      deepMerge(target[key], value as Record<string, any>);
      return;
    }
    target[key] = value;
  });
  return target;
};

const buildPresetDefaults = (presetId: string) => {
  const base = deepClone(defaultParams) as Record<string, any>;
  const presetDef = visualizerPresets.find((preset) => preset.id === presetId);
  if (presetDef?.params) {
    deepMerge(base, presetDef.params as Record<string, any>);
  }
  base.preset = presetId;
  return base;
};

const buildPresetState = (presetId: string, stored?: Record<string, any>) => {
  const base = buildPresetDefaults(presetId);
  if (stored) {
    deepMerge(base, stored);
  }
  return base;
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
  const { trackName } = useAudioLounge();

  const [params, setParams] = useState<Record<string, any> | null>(null);
  const [schema, setSchema] = useState<ParamSchemaItem[]>([]);
  const [presetOptions, setPresetOptions] = useState<PresetOption[]>([]);
  const [presetId, setPresetId] = useState<string | null>(null);
  const storageRef = useRef<VisualizerStorage>({});
  const isHydratingRef = useRef(false);

  useEffect(() => {
    if (!visualizer) return;

    storageRef.current = readVisualizerStorage();

    setSchema(visualizer.getParamSchema() as ParamSchemaItem[]);
    const presetList = visualizer.getPresets();
    setPresetOptions(presetList);

    const presetIds = new Set(presetList.map((preset) => preset.id));
    const currentParams = visualizer.getParams();
    let targetPreset = currentParams.preset ?? null;

    if (storageRef.current.activePreset && presetIds.has(storageRef.current.activePreset)) {
      targetPreset = storageRef.current.activePreset;
    }

    if (targetPreset && targetPreset !== currentParams.preset) {
      isHydratingRef.current = true;
      visualizer.setPreset(targetPreset);
      isHydratingRef.current = false;
    }

    if (targetPreset) {
      const storedParams = storageRef.current.presets?.[targetPreset];
      const nextParams = buildPresetState(targetPreset, storedParams);
      isHydratingRef.current = true;
      visualizer.setParams(nextParams);
      isHydratingRef.current = false;
    }

    setParams(visualizer.getParams());
    setPresetId(visualizer.getParams().preset ?? null);

    const unsubscribeParams = visualizer.on("params", ({ params: nextParams }) => {
      setParams(nextParams as Record<string, any>);
      if (isHydratingRef.current) return;
      const activePreset = (nextParams as Record<string, any>).preset as string | undefined;
      if (!activePreset) return;
      const nextStorage: VisualizerStorage = {
        activePreset,
        presets: {
          ...(storageRef.current.presets ?? {}),
          [activePreset]: nextParams as Record<string, any>
        }
      };
      storageRef.current = nextStorage;
      writeVisualizerStorage(nextStorage);
    });
    const unsubscribePreset = visualizer.on("preset", ({ id }) => {
      setPresetId(id);
      const storedParams = storageRef.current.presets?.[id];
      const nextParams = buildPresetState(id, storedParams);
      isHydratingRef.current = true;
      visualizer.setParams(nextParams);
      isHydratingRef.current = false;
    });

    return () => {
      unsubscribeParams?.();
      unsubscribePreset?.();
    };
  }, [visualizer]);

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

  const handleResetPreset = useCallback(() => {
    if (!visualizer || !presetId) return;
    const defaults = buildPresetDefaults(presetId);
    isHydratingRef.current = true;
    visualizer.setParams(defaults);
    isHydratingRef.current = false;
    const nextStorage: VisualizerStorage = {
      ...storageRef.current,
      activePreset: presetId,
      presets: { ...(storageRef.current.presets ?? {}) }
    };
    delete nextStorage.presets?.[presetId];
    storageRef.current = nextStorage;
    writeVisualizerStorage(nextStorage);
  }, [presetId, visualizer]);

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

      <AudioControls />

      <Group>
        <GroupTitle>Preset</GroupTitle>
        <Label>
          Visualizer
          <Select value={presetId ?? ""} onChange={handlePresetChange}>
            {presetOptions.map((preset) => (
              <option key={preset.id} value={preset.id}>
                {preset.label}
              </option>
            ))}
          </Select>
        </Label>
        <div className="hudControlRow">
          <Button variant="ghost" onClick={handleResetPreset} disabled={!presetId}>
            Reset preset
          </Button>
        </div>
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
