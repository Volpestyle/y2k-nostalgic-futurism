import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createHoloClient, type ModelMetadata } from "@holo/sdk";
import { BasicGltfViewer } from "@holo/viewer-three";
import { BakeSpecSchema } from "@holo/shared-spec";
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
  PanelTitle,
  Range,
  Select,
  Status,
  Textarea
} from "@holo/ui-kit";
import { parseNpyFloat32 } from "./npy";

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || "http://localhost:8080").replace(
  /\/$/,
  ""
);
const client = createHoloClient(API_BASE_URL);
const defaultCaptionPrompt =
  "Describe the subject and materials in this image for 3D reconstruction. Keep it brief.";

type ViewManifestEntry = {
  id?: string;
  image_path?: string;
  depth_path?: string;
  depth_min?: number;
  depth_max?: number;
  width?: number;
  height?: number;
};

type ViewManifest = {
  version?: number;
  fov_deg?: number;
  views?: ViewManifestEntry[];
};

const getBasename = (raw: string) => {
  const parts = raw.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] ?? "";
};

const buildDepthPreview = (
  data: Float32Array,
  shape: number[],
  depthMin?: number,
  depthMax?: number
) => {
  const height = shape[0] ?? 0;
  const width = shape[1] ?? 0;
  if (!height || !width) return null;

  let min = Number.isFinite(depthMin) ? (depthMin as number) : Number.POSITIVE_INFINITY;
  let max = Number.isFinite(depthMax) ? (depthMax as number) : Number.NEGATIVE_INFINITY;
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) {
    for (let i = 0; i < data.length; i += 1) {
      const value = data[i];
      if (!Number.isFinite(value) || value <= 0) continue;
      if (value < min) min = value;
      if (value > max) max = value;
    }
  }
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) {
    return null;
  }

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const imageData = ctx.createImageData(width, height);
  const span = max - min;

  for (let i = 0; i < data.length; i += 1) {
    const value = data[i];
    const normalized = Number.isFinite(value) && value > 0 ? (value - min) / span : 0;
    const color = Math.max(0, Math.min(255, Math.round(normalized * 255)));
    const idx = i * 4;
    imageData.data[idx] = color;
    imageData.data[idx + 1] = color;
    imageData.data[idx + 2] = color;
    imageData.data[idx + 3] = 255;
  }

  ctx.putImageData(imageData, 0, 0);
  return canvas.toDataURL("image/png");
};

const safeParseJson = (raw: string) => {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

const getModelLabel = (model: ModelMetadata | undefined, fallback: string) => {
  return model?.displayName || model?.id || fallback;
};

const buildApiKey = (provider: string, model: string) => `${provider}::${model}`;

const parseApiKey = (raw: string) => {
  const [provider, model] = raw.split("::");
  return { provider, model };
};
type PipelineSource = "local" | "api";

export function CreateModelsPanel() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const viewerRef = useRef<BasicGltfViewer | null>(null);

  const [file, setFile] = useState<File | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [status, setStatus] = useState<string>("idle");
  const [progress, setProgress] = useState<number>(0);
  const [error, setError] = useState<string | null>(null);
  const [models, setModels] = useState<ModelMetadata[]>([]);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [modelsLoaded, setModelsLoaded] = useState(false);
  const [cutoutPreview, setCutoutPreview] = useState<string | null>(null);
  const [viewsManifest, setViewsManifest] = useState<ViewManifest | null>(null);
  const [depthManifest, setDepthManifest] = useState<ViewManifest | null>(null);
  const [depthPreviewImage, setDepthPreviewImage] = useState<string | null>(null);
  const [depthMaps, setDepthMaps] = useState<Record<string, string>>({});
  const cutoutPreviewRef = useRef<string | null>(null);
  const depthPreviewRef = useRef<string | null>(null);
  const depthMapsRef = useRef<Record<string, string>>({});
  const artifactsLoadedRef = useRef({ cutout: false, views: false, depth: false });

  const [cutoutSource, setCutoutSource] = useState<PipelineSource>("local");
  const [cutoutModel, setCutoutModel] = useState("rmbg-1.4");
  const [cutoutProvider, setCutoutProvider] = useState("openai");
  const [cutoutApiModel, setCutoutApiModel] = useState("");
  const [depthSource, setDepthSource] = useState<PipelineSource>("local");
  const [depthModel, setDepthModel] = useState("depth-anything-v2-small");
  const [depthProvider, setDepthProvider] = useState("openai");
  const [depthApiModel, setDepthApiModel] = useState("");
  const [viewsSource, setViewsSource] = useState<PipelineSource>("local");
  const [viewsModel, setViewsModel] = useState("stable-zero123");
  const [viewsProvider, setViewsProvider] = useState("openai");
  const [viewsApiModel, setViewsApiModel] = useState("");
  const [viewsCount, setViewsCount] = useState(8);
  const [captionEnabled, setCaptionEnabled] = useState(false);
  const [captionProvider, setCaptionProvider] = useState("openai");
  const [captionModel, setCaptionModel] = useState("gpt-4o-mini");
  const [captionPrompt, setCaptionPrompt] = useState(defaultCaptionPrompt);

  useEffect(() => {
    if (!canvasRef.current) return;
    viewerRef.current = new BasicGltfViewer({ canvas: canvasRef.current });

    const onResize = () => viewerRef.current?.resize();
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      viewerRef.current?.dispose();
      viewerRef.current = null;
    };
  }, []);

  useEffect(() => {
    return () => {
      if (cutoutPreviewRef.current) {
        URL.revokeObjectURL(cutoutPreviewRef.current);
      }
      if (depthPreviewRef.current) {
        URL.revokeObjectURL(depthPreviewRef.current);
      }
    };
  }, []);

  useEffect(() => {
    artifactsLoadedRef.current = { cutout: false, views: false, depth: false };
    depthMapsRef.current = {};
    if (cutoutPreviewRef.current) {
      URL.revokeObjectURL(cutoutPreviewRef.current);
      cutoutPreviewRef.current = null;
    }
    if (depthPreviewRef.current) {
      URL.revokeObjectURL(depthPreviewRef.current);
      depthPreviewRef.current = null;
    }
    setCutoutPreview(null);
    setViewsManifest(null);
    setDepthManifest(null);
    setDepthPreviewImage(null);
    setDepthMaps({});
  }, [jobId]);

  useEffect(() => {
    depthMapsRef.current = depthMaps;
  }, [depthMaps]);

  useEffect(() => {
    let cancelled = false;
    const loadModels = async () => {
      try {
        const data = await client.listProviderModels();
        if (cancelled) return;
        setModels(data);
        setModelsError(null);
      } catch (err: any) {
        if (cancelled) return;
        setModelsError(String(err?.message || err));
      } finally {
        if (!cancelled) {
          setModelsLoaded(true);
        }
      }
    };
    loadModels();
    return () => {
      cancelled = true;
    };
  }, []);

  const visionModels = useMemo(
    () => models.filter((model) => model.provider !== "catalog" && model.capabilities?.vision),
    [models]
  );
  const catalogModels = useMemo(
    () => models.filter((model) => model.provider === "catalog"),
    [models]
  );
  const cutoutOptions = useMemo(
    () => catalogModels.filter((model) => model.family === "cutout"),
    [catalogModels]
  );
  const depthOptions = useMemo(
    () => catalogModels.filter((model) => model.family === "depth"),
    [catalogModels]
  );
  const viewsOptions = useMemo(
    () => catalogModels.filter((model) => model.family === "views"),
    [catalogModels]
  );
  const providerOptions = useMemo(() => {
    return Array.from(new Set(visionModels.map((model) => model.provider))).sort();
  }, [visionModels]);
  const cutoutProviderModels = useMemo(() => {
    return visionModels.filter((model) => model.provider === cutoutProvider);
  }, [visionModels, cutoutProvider]);
  const depthProviderModels = useMemo(() => {
    return visionModels.filter((model) => model.provider === depthProvider);
  }, [visionModels, depthProvider]);
  const viewsProviderModels = useMemo(() => {
    return visionModels.filter((model) => model.provider === viewsProvider);
  }, [visionModels, viewsProvider]);
  const providerModels = useMemo(() => {
    return visionModels.filter((model) => model.provider === captionProvider);
  }, [visionModels, captionProvider]);
  const apiModelGroups = useMemo(() => {
    const grouped = new Map<string, ModelMetadata[]>();
    for (const model of visionModels) {
      const list = grouped.get(model.provider);
      if (list) {
        list.push(model);
      } else {
        grouped.set(model.provider, [model]);
      }
    }
    return Array.from(grouped.entries())
      .map(([provider, groupedModels]) => ({
        provider,
        models: [...groupedModels].sort((a, b) => {
          const aLabel = a.displayName || a.id;
          const bLabel = b.displayName || b.id;
          return aLabel.localeCompare(bLabel);
        })
      }))
      .sort((a, b) => a.provider.localeCompare(b.provider));
  }, [visionModels]);
  const cutoutProviderValue = providerOptions.length > 0 ? cutoutProvider : "";
  const cutoutApiModelValue = cutoutProviderModels.length > 0 ? cutoutApiModel : "";
  const depthProviderValue = providerOptions.length > 0 ? depthProvider : "";
  const depthApiModelValue = depthProviderModels.length > 0 ? depthApiModel : "";
  const viewsProviderValue = providerOptions.length > 0 ? viewsProvider : "";
  const viewsApiModelValue = viewsProviderModels.length > 0 ? viewsApiModel : "";
  const captionProviderValue = providerOptions.length > 0 ? captionProvider : "";
  const captionModelValue = providerModels.length > 0 ? captionModel : "";
  const viewsModelValue = viewsOptions.length > 0 ? viewsModel : "";
  const cutoutApiSelection =
    cutoutProviderValue && cutoutApiModelValue
      ? buildApiKey(cutoutProviderValue, cutoutApiModelValue)
      : "";
  const depthApiSelection =
    depthProviderValue && depthApiModelValue
      ? buildApiKey(depthProviderValue, depthApiModelValue)
      : "";
  const viewsApiSelection =
    viewsProviderValue && viewsApiModelValue
      ? buildApiKey(viewsProviderValue, viewsApiModelValue)
      : "";
  const captionSelection =
    captionProviderValue && captionModelValue
      ? buildApiKey(captionProviderValue, captionModelValue)
      : "";
  const artifactBase = useMemo(() => {
    if (!jobId) return null;
    return `${API_BASE_URL}/v1/jobs/${jobId}/artifacts`;
  }, [jobId]);
  const getArtifactUrl = useCallback(
    (path: string) => {
      if (!artifactBase) return "";
      return `${artifactBase}/${path}?t=${jobId}`;
    },
    [artifactBase, jobId]
  );
  const viewItems = useMemo(() => {
    const views = viewsManifest?.views ?? [];
    return views.map((view, index) => {
      const fallbackId = `view_${String(index).padStart(3, "0")}`;
      const id = view.id || fallbackId;
      const imageName = view.image_path ? getBasename(view.image_path) : `${id}.png`;
      return {
        id,
        label: id.replace(/^view_/, "View "),
        url: getArtifactUrl(`views/${imageName}`)
      };
    });
  }, [viewsManifest, getArtifactUrl]);
  const depthItems = useMemo(() => {
    const views = depthManifest?.views ?? [];
    return views.map((view, index) => {
      const fallbackId = `view_${String(index).padStart(3, "0")}`;
      const id = view.id || fallbackId;
      const depthName = view.depth_path ? getBasename(view.depth_path) : "";
      return {
        id,
        label: id.replace(/^view_/, "View "),
        depthMin: view.depth_min,
        depthMax: view.depth_max,
        depthUrl: depthName ? getArtifactUrl(`depth/${depthName}`) : ""
      };
    });
  }, [depthManifest, getArtifactUrl]);

  useEffect(() => {
    if (!visionModels.length) return;
    if (!visionModels.some((model) => model.provider === captionProvider)) {
      setCaptionProvider(visionModels[0].provider);
    }
  }, [visionModels, captionProvider]);

  useEffect(() => {
    if (!visionModels.length) return;
    if (!visionModels.some((model) => model.provider === cutoutProvider)) {
      setCutoutProvider(visionModels[0].provider);
    }
  }, [visionModels, cutoutProvider]);

  useEffect(() => {
    if (!visionModels.length) return;
    if (!visionModels.some((model) => model.provider === depthProvider)) {
      setDepthProvider(visionModels[0].provider);
    }
  }, [visionModels, depthProvider]);

  useEffect(() => {
    if (!visionModels.length) return;
    if (!visionModels.some((model) => model.provider === viewsProvider)) {
      setViewsProvider(visionModels[0].provider);
    }
  }, [visionModels, viewsProvider]);

  useEffect(() => {
    if (!cutoutOptions.length) return;
    if (!cutoutOptions.some((model) => model.id === cutoutModel)) {
      setCutoutModel(cutoutOptions[0].id);
    }
  }, [cutoutOptions, cutoutModel]);

  useEffect(() => {
    if (!depthOptions.length) return;
    if (!depthOptions.some((model) => model.id === depthModel)) {
      setDepthModel(depthOptions[0].id);
    }
  }, [depthOptions, depthModel]);

  useEffect(() => {
    if (!viewsOptions.length) return;
    if (!viewsOptions.some((model) => model.id === viewsModel)) {
      setViewsModel(viewsOptions[0].id);
    }
  }, [viewsOptions, viewsModel]);

  useEffect(() => {
    if (!cutoutProviderModels.length) return;
    if (!cutoutProviderModels.some((model) => model.id === cutoutApiModel)) {
      setCutoutApiModel(cutoutProviderModels[0].id);
    }
  }, [cutoutProviderModels, cutoutApiModel]);

  useEffect(() => {
    if (!depthProviderModels.length) return;
    if (!depthProviderModels.some((model) => model.id === depthApiModel)) {
      setDepthApiModel(depthProviderModels[0].id);
    }
  }, [depthProviderModels, depthApiModel]);

  useEffect(() => {
    if (!viewsProviderModels.length) return;
    if (!viewsProviderModels.some((model) => model.id === viewsApiModel)) {
      setViewsApiModel(viewsProviderModels[0].id);
    }
  }, [viewsProviderModels, viewsApiModel]);

  useEffect(() => {
    if (!providerModels.length) return;
    if (!providerModels.some((model) => model.id === captionModel)) {
      setCaptionModel(providerModels[0].id);
    }
  }, [providerModels, captionModel]);

  const refreshArtifacts = useCallback(async () => {
    if (!artifactBase) return;

    if (!artifactsLoadedRef.current.cutout) {
      try {
        const res = await fetch(getArtifactUrl("cutout.png"), { cache: "no-store" });
        if (res.ok) {
          const blob = await res.blob();
          if (cutoutPreviewRef.current) {
            URL.revokeObjectURL(cutoutPreviewRef.current);
          }
          const url = URL.createObjectURL(blob);
          cutoutPreviewRef.current = url;
          setCutoutPreview(url);
          artifactsLoadedRef.current.cutout = true;
        }
      } catch {
        // ignore
      }
    }

    if (!artifactsLoadedRef.current.views) {
      try {
        const res = await fetch(getArtifactUrl("views.json"), { cache: "no-store" });
        if (res.ok) {
          const raw = await res.text();
          const manifest = safeParseJson(raw);
          if (manifest && Array.isArray(manifest.views)) {
            setViewsManifest(manifest as ViewManifest);
            artifactsLoadedRef.current.views = true;
          }
        }
      } catch {
        // ignore
      }
    }

    if (!artifactsLoadedRef.current.depth) {
      try {
        const res = await fetch(getArtifactUrl("depth.json"), { cache: "no-store" });
        if (res.ok) {
          const contentType = res.headers.get("content-type") ?? "";
          if (contentType.includes("application/json") || contentType.includes("text/")) {
            const raw = await res.text();
            const manifest = safeParseJson(raw);
            if (manifest && Array.isArray(manifest.views)) {
              setDepthManifest(manifest as ViewManifest);
              artifactsLoadedRef.current.depth = true;
              return;
            }
          }
          const blob = await res.blob();
          if (depthPreviewRef.current) {
            URL.revokeObjectURL(depthPreviewRef.current);
          }
          const url = URL.createObjectURL(blob);
          depthPreviewRef.current = url;
          setDepthPreviewImage(url);
          artifactsLoadedRef.current.depth = true;
        }
      } catch {
        // ignore
      }
    }
  }, [artifactBase, getArtifactUrl]);

  useEffect(() => {
    if (depthItems.length === 0) return;
    let cancelled = false;

    const loadDepthMaps = async () => {
      for (const item of depthItems) {
        if (!item.depthUrl || depthMapsRef.current[item.id]) continue;
        try {
          const res = await fetch(item.depthUrl, { cache: "no-store" });
          if (!res.ok) continue;
          const buffer = await res.arrayBuffer();
          const { data, shape } = parseNpyFloat32(buffer);
          const preview = buildDepthPreview(data, shape, item.depthMin, item.depthMax);
          if (!preview || cancelled) continue;
          setDepthMaps((prev) => ({ ...prev, [item.id]: preview }));
        } catch {
          // ignore
        }
      }
    };

    loadDepthMaps();
    return () => {
      cancelled = true;
    };
  }, [depthItems]);

  const applyApiSelection = (
    value: string,
    setProvider: (provider: string) => void,
    setModel: (model: string) => void
  ) => {
    if (!value) return;
    const { provider, model } = parseApiKey(value);
    if (provider && model) {
      setProvider(provider);
      setModel(model);
    }
  };

  async function startBake() {
    setError(null);
    if (!file) return;

    const useCutoutApi = cutoutSource === "api" && cutoutProviderValue && cutoutApiModelValue;
    const useDepthApi = depthSource === "api" && depthProviderValue && depthApiModelValue;
    const useViewsApi = viewsSource === "api" && viewsProviderValue && viewsApiModelValue;

    const cutoutConfig = useCutoutApi
      ? { provider: cutoutProviderValue, model: cutoutApiModelValue }
      : { model: cutoutModel };
    const depthConfig = useDepthApi
      ? { provider: depthProviderValue, model: depthApiModelValue }
      : { model: depthModel };
    const viewsConfig: Record<string, unknown> = { count: viewsCount };
    if (useViewsApi) {
      viewsConfig.provider = viewsProviderValue;
      viewsConfig.model = viewsApiModelValue;
    } else if (viewsModelValue) {
      viewsConfig.model = viewsModelValue;
    }

    const bakeSpec = BakeSpecSchema.parse({
      version: "0.1.0",
      cutout: cutoutConfig,
      depth: depthConfig,
      views: viewsConfig,
      mesh: { targetTris: 2000 },
      ai: {
        caption: {
          enabled: captionEnabled,
          provider: captionProvider,
          model: captionModel,
          prompt: captionPrompt
        }
      }
    });

    setStatus("uploading");
    const { jobId } = await client.createJob({ image: file, bakeSpec });
    setJobId(jobId);
    setStatus("queued");
  }

  useEffect(() => {
    if (!jobId) return;
    let cancelled = false;

    const tick = async () => {
      try {
        const j = await client.getJob(jobId);
        if (cancelled) return;
        setStatus(j.status);
        setProgress(j.progress);
        await refreshArtifacts();
        if (j.status === "done") {
          const url = client.getResultUrl(jobId);
          await viewerRef.current?.load(url);
          return;
        }
        if (j.status === "error") {
          setError(j.error || "unknown error");
          return;
        }
        setTimeout(tick, 800);
      } catch (e: any) {
        setError(String(e?.message || e));
      }
    };

    tick();
    return () => {
      cancelled = true;
    };
  }, [jobId, refreshArtifacts]);

  return (
    <div className="hudPanelStack">
      <Panel className="hudPanel">
        <PanelTitle>Model Forge</PanelTitle>
        <Label>
          Image file
          <Input
            type="file"
            accept="image/*"
            onChange={(e) => setFile(e.target.files?.[0] || null)}
          />
        </Label>

        <Group>
          <GroupTitle>Pipeline models</GroupTitle>
          <div className="hudPipelineGrid">
            <div className="hudPipelineStage">
              <div className="hudPipelineHeader">
                <div>
                  <div className="hudPipelineTitle">Cutout</div>
                  <div className="hudPipelineMeta">
                    {cutoutSource === "local" ? "Catalog model" : "API model"}
                  </div>
                </div>
                <div className="hudSourceToggle" role="radiogroup" aria-label="Cutout source">
                  <button
                    type="button"
                    className="hudSourceButton"
                    data-active={cutoutSource === "local"}
                    aria-pressed={cutoutSource === "local"}
                    onClick={() => setCutoutSource("local")}
                  >
                    Local
                  </button>
                  <button
                    type="button"
                    className="hudSourceButton"
                    data-active={cutoutSource === "api"}
                    aria-pressed={cutoutSource === "api"}
                    onClick={() => setCutoutSource("api")}
                    disabled={providerOptions.length === 0}
                  >
                    API
                  </button>
                </div>
              </div>
              <Label>
                Model
                <Select
                  value={
                    cutoutSource === "local"
                      ? cutoutOptions.length > 0
                        ? cutoutModel
                        : ""
                      : cutoutApiSelection
                  }
                  onChange={(e) => {
                    if (cutoutSource === "local") {
                      setCutoutModel(e.target.value);
                    } else {
                      applyApiSelection(e.target.value, setCutoutProvider, setCutoutApiModel);
                    }
                  }}
                  disabled={cutoutSource === "local" ? cutoutOptions.length === 0 : apiModelGroups.length === 0}
                >
                  {cutoutSource === "local" ? (
                    cutoutOptions.length === 0 ? (
                      <option value="">No cutout models available</option>
                    ) : (
                      cutoutOptions.map((model) => (
                        <option key={model.id} value={model.id}>
                          {getModelLabel(model, model.id)}
                        </option>
                      ))
                    )
                  ) : apiModelGroups.length === 0 ? (
                    <option value="">No models available</option>
                  ) : (
                    apiModelGroups.map((group) => (
                      <optgroup key={group.provider} label={group.provider}>
                        {group.models.map((model) => (
                          <option
                            key={`${group.provider}:${model.id}`}
                            value={buildApiKey(group.provider, model.id)}
                          >
                            {getModelLabel(model, model.id)}
                          </option>
                        ))}
                      </optgroup>
                    ))
                  )}
                </Select>
              </Label>
            </div>

            <div className="hudPipelineStage">
              <div className="hudPipelineHeader">
                <div>
                  <div className="hudPipelineTitle">Depth</div>
                  <div className="hudPipelineMeta">
                    {depthSource === "local" ? "Catalog model" : "API model"}
                  </div>
                </div>
                <div className="hudSourceToggle" role="radiogroup" aria-label="Depth source">
                  <button
                    type="button"
                    className="hudSourceButton"
                    data-active={depthSource === "local"}
                    aria-pressed={depthSource === "local"}
                    onClick={() => setDepthSource("local")}
                  >
                    Local
                  </button>
                  <button
                    type="button"
                    className="hudSourceButton"
                    data-active={depthSource === "api"}
                    aria-pressed={depthSource === "api"}
                    onClick={() => setDepthSource("api")}
                    disabled={providerOptions.length === 0}
                  >
                    API
                  </button>
                </div>
              </div>
              <Label>
                Model
                <Select
                  value={
                    depthSource === "local"
                      ? depthOptions.length > 0
                        ? depthModel
                        : ""
                      : depthApiSelection
                  }
                  onChange={(e) => {
                    if (depthSource === "local") {
                      setDepthModel(e.target.value);
                    } else {
                      applyApiSelection(e.target.value, setDepthProvider, setDepthApiModel);
                    }
                  }}
                  disabled={depthSource === "local" ? depthOptions.length === 0 : apiModelGroups.length === 0}
                >
                  {depthSource === "local" ? (
                    depthOptions.length === 0 ? (
                      <option value="">No depth models available</option>
                    ) : (
                      depthOptions.map((model) => (
                        <option key={model.id} value={model.id}>
                          {getModelLabel(model, model.id)}
                        </option>
                      ))
                    )
                  ) : apiModelGroups.length === 0 ? (
                    <option value="">No models available</option>
                  ) : (
                    apiModelGroups.map((group) => (
                      <optgroup key={group.provider} label={group.provider}>
                        {group.models.map((model) => (
                          <option
                            key={`${group.provider}:${model.id}`}
                            value={buildApiKey(group.provider, model.id)}
                          >
                            {getModelLabel(model, model.id)}
                          </option>
                        ))}
                      </optgroup>
                    ))
                  )}
                </Select>
              </Label>
            </div>

            <div className="hudPipelineStage">
              <div className="hudPipelineHeader">
                <div>
                  <div className="hudPipelineTitle">Views</div>
                  <div className="hudPipelineMeta">
                    {viewsSource === "local" ? "Catalog model" : "API model"}
                  </div>
                </div>
                <div className="hudSourceToggle" role="radiogroup" aria-label="View source">
                  <button
                    type="button"
                    className="hudSourceButton"
                    data-active={viewsSource === "local"}
                    aria-pressed={viewsSource === "local"}
                    onClick={() => setViewsSource("local")}
                  >
                    Local
                  </button>
                  <button
                    type="button"
                    className="hudSourceButton"
                    data-active={viewsSource === "api"}
                    aria-pressed={viewsSource === "api"}
                    onClick={() => setViewsSource("api")}
                    disabled={providerOptions.length === 0}
                  >
                    API
                  </button>
                </div>
              </div>
              <Label>
                Model
                <Select
                  value={viewsSource === "local" ? viewsModelValue : viewsApiSelection}
                  onChange={(e) => {
                    if (viewsSource === "local") {
                      setViewsModel(e.target.value);
                    } else {
                      applyApiSelection(e.target.value, setViewsProvider, setViewsApiModel);
                    }
                  }}
                  disabled={viewsSource === "local" ? viewsOptions.length === 0 : apiModelGroups.length === 0}
                >
                  {viewsSource === "local" ? (
                    viewsOptions.length === 0 ? (
                      <option value="">No view models available</option>
                    ) : (
                      viewsOptions.map((model) => (
                        <option key={model.id} value={model.id}>
                          {getModelLabel(model, model.id)}
                        </option>
                      ))
                    )
                  ) : apiModelGroups.length === 0 ? (
                    <option value="">No models available</option>
                  ) : (
                    apiModelGroups.map((group) => (
                      <optgroup key={group.provider} label={group.provider}>
                        {group.models.map((model) => (
                          <option
                            key={`${group.provider}:${model.id}`}
                            value={buildApiKey(group.provider, model.id)}
                          >
                            {getModelLabel(model, model.id)}
                          </option>
                        ))}
                      </optgroup>
                    ))
                  )}
                </Select>
              </Label>
              <Label className="hudSlider">
                View count: {viewsCount}
                <Range
                  min={4}
                  max={12}
                  step={1}
                  value={viewsCount}
                  onChange={(e) => setViewsCount(Number(e.target.value))}
                />
              </Label>
            </div>
          </div>
          {modelsError && <Hint>Model list error: {modelsError}</Hint>}
          {modelsLoaded &&
            !modelsError &&
            cutoutOptions.length === 0 &&
            depthOptions.length === 0 && (
              <Hint>No local pipeline models available from ai-kit catalog.</Hint>
            )}
          {modelsLoaded && !modelsError && providerOptions.length === 0 && (
            <Hint>No API image models available from ai-kit providers.</Hint>
          )}
        </Group>

        <Group>
          <GroupTitle>AI caption</GroupTitle>
          <Label className="ui-toggle">
            <Checkbox
              checked={captionEnabled}
              onChange={(e) => setCaptionEnabled(e.target.checked)}
            />
            Enable captioning
          </Label>
          <Label>
            Model
            <Select
              value={captionSelection}
              onChange={(e) => applyApiSelection(e.target.value, setCaptionProvider, setCaptionModel)}
              disabled={!captionEnabled || apiModelGroups.length === 0}
            >
              {apiModelGroups.length === 0 ? (
                <option value="">No models available</option>
              ) : (
                apiModelGroups.map((group) => (
                  <optgroup key={group.provider} label={group.provider}>
                    {group.models.map((model) => (
                      <option
                        key={`${group.provider}:${model.id}`}
                        value={buildApiKey(group.provider, model.id)}
                      >
                        {getModelLabel(model, model.id)}
                      </option>
                    ))}
                  </optgroup>
                ))
              )}
            </Select>
          </Label>
          <Label>
            Prompt
            <Textarea
              rows={3}
              value={captionPrompt}
              onChange={(e) => setCaptionPrompt(e.target.value)}
              disabled={!captionEnabled}
            />
          </Label>
          {modelsError && <Hint>Model list error: {modelsError}</Hint>}
          {!modelsError && providerOptions.length === 0 && (
            <Hint>No vision-capable models available from ai-kit.</Hint>
          )}
        </Group>

        <div className="hudActions">
          <Button disabled={!file} onClick={startBake}>
            Start bake
          </Button>
          <Badge className="hudBadge">API {client.getResultUrl("<job>").split("/v1/")[0]}</Badge>
        </div>

        <Status className="hudStatus">
          <div>
            <strong>Status:</strong> {status}
          </div>
          <div>
            <strong>Progress:</strong> {(progress * 100).toFixed(0)}%
          </div>
          {jobId && (
            <div>
              <strong>Job:</strong> {jobId}
            </div>
          )}
          {error && <pre className="ui-error">{error}</pre>}
        </Status>
      </Panel>

      <Panel className="hudPanel">
        <PanelTitle>Viewer</PanelTitle>
        <div className="hudViewerFrame">
          <canvas ref={canvasRef} className="hudViewerCanvas" />
        </div>
        <Hint>Model preview loads once the bake completes.</Hint>
      </Panel>

      <Panel className="hudPanel">
        <PanelTitle>Pipeline previews</PanelTitle>
        <Group>
          <GroupTitle>Cutout</GroupTitle>
          {cutoutPreview ? (
            <div className="hudArtifactFrame hudCutoutFrame">
              <img src={cutoutPreview} alt="Cutout preview" />
            </div>
          ) : (
            <Status>Waiting for cutout stage...</Status>
          )}
        </Group>

        <Group>
          <GroupTitle>Views</GroupTitle>
          {viewItems.length > 0 ? (
            <div className="hudArtifactGrid">
              {viewItems.map((view) => (
                <div className="hudArtifactCard" key={view.id}>
                  <img
                    className="hudArtifactThumb"
                    src={view.url}
                    alt={`View ${view.label}`}
                    loading="lazy"
                  />
                  <span className="hudArtifactLabel">{view.label}</span>
                </div>
              ))}
            </div>
          ) : (
            <Status>Waiting for view synthesis...</Status>
          )}
        </Group>

        <Group>
          <GroupTitle>Depth</GroupTitle>
          {depthPreviewImage ? (
            <div className="hudArtifactFrame">
              <img src={depthPreviewImage} alt="Depth preview" />
            </div>
          ) : depthItems.length > 0 ? (
            <div className="hudArtifactGrid">
              {depthItems.map((view) => (
                <div className="hudArtifactCard" key={view.id}>
                  {depthMaps[view.id] ? (
                    <img
                      className="hudArtifactThumb hudDepthThumb"
                      src={depthMaps[view.id]}
                      alt={`Depth ${view.label}`}
                      loading="lazy"
                    />
                  ) : (
                    <div className="hudArtifactPlaceholder">Loading</div>
                  )}
                  <span className="hudArtifactLabel">{view.label}</span>
                </div>
              ))}
            </div>
          ) : (
            <Status>Waiting for depth pass...</Status>
          )}
          {depthItems.length > 0 && Object.keys(depthMaps).length === 0 && (
            <Hint>Parsing depth maps...</Hint>
          )}
        </Group>
      </Panel>
    </div>
  );
}
