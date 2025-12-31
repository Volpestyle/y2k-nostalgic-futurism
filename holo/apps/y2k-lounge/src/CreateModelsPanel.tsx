import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  createHoloClient,
  type JobStatusResponse,
  type ModelInputSpec,
  type ModelMetadata,
} from "@holo/sdk";
import { BasicGltfViewer, type RenderMode } from "@holo/viewer-three";
import { defaultParams } from "@holo/visualizer-three";
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
  Textarea,
} from "@holo/ui-kit";
import { parseNpyFloat32 } from "./npy";

const API_BASE_URL = (
  import.meta.env.VITE_API_BASE_URL || "http://localhost:8080"
).replace(/\/$/, "");
const client = createHoloClient(API_BASE_URL);
const defaultCaptionPrompt =
  "Describe the subject and materials in this image for 3D reconstruction. Keep it brief.";
const defaultCutoutPrompt =
  "Return a PNG cutout of the subject with transparency (alpha).";
const defaultDepthPrompt =
  "Generate a grayscale depth map of the input image (white=near, black=far).";
const defaultViewsPrompt =
  "Generate a novel view of the input subject, preserving identity and material. Output a single image.";
const defaultReconPrompt =
  "Generate a 3D mesh from the input multi-view images.";
const PIPELINE_STORAGE_KEY = "y2k-lounge.pipeline-selection";
const PIPELINE_STAGES = ["normalize", "remove_bg", "multiview", "depth", "recon"];

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

type JobEventPayload = {
  sort?: number;
  event?: {
    kind?: string;
    stage?: string;
    message?: string;
    progress?: number;
    artifact?: {
      name?: string;
    };
  };
};

type JobEventEntry = {
  id: number;
  kind: string;
  stage: string;
  message?: string;
  progress?: number;
  artifactName?: string;
};

const getBasename = (raw: string) => {
  const parts = raw.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] ?? "";
};

const depthModelUsesInverse = (modelId: string) =>
  modelId.toLowerCase().includes("depth-anything");

const viewsModelUsesFixedViews = (modelId: string) =>
  modelId.toLowerCase().includes("zero123");

const buildDepthPreview = (
  data: Float32Array,
  shape: number[],
  depthMin?: number,
  depthMax?: number
) => {
  const height = shape[0] ?? 0;
  const width = shape[1] ?? 0;
  if (!height || !width) return null;

  let min = Number.isFinite(depthMin)
    ? (depthMin as number)
    : Number.POSITIVE_INFINITY;
  let max = Number.isFinite(depthMax)
    ? (depthMax as number)
    : Number.NEGATIVE_INFINITY;
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
    const normalized =
      Number.isFinite(value) && value > 0 ? (value - min) / span : 0;
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

const parseParameters = (raw: string) => {
  if (!raw.trim()) return null;
  const parsed = safeParseJson(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    return null;
  return parsed as Record<string, unknown>;
};

const resolveInputValue = (
  input: ModelInputSpec,
  params: Record<string, unknown>
) => {
  const raw = params[input.name];
  if (raw === undefined) {
    if (input.default !== undefined) return input.default;
    if (input.type === "boolean") return false;
    return "";
  }
  if (input.type === "number") {
    if (typeof raw === "number") return raw;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : "";
  }
  if (input.type === "boolean") {
    return Boolean(raw);
  }
  return typeof raw === "string" ? raw : String(raw);
};

const upsertParameterValue = (
  setRaw: React.Dispatch<React.SetStateAction<string>>,
  name: string,
  value: unknown
) => {
  setRaw((prev) => {
    const parsed = parseParameters(prev) || {};
    const next = { ...parsed };
    if (value === "" || value === undefined) {
      delete next[name];
    } else {
      next[name] = value;
    }
    return JSON.stringify(next, null, 2);
  });
};

type ModelInputsEditorProps = {
  inputs?: ModelInputSpec[];
  parametersRaw: string;
  setParametersRaw: React.Dispatch<React.SetStateAction<string>>;
  disabled?: boolean;
};

const ModelInputsEditor = ({
  inputs,
  parametersRaw,
  setParametersRaw,
  disabled,
}: ModelInputsEditorProps) => {
  if (!inputs || inputs.length === 0) return null;
  const parsed = parseParameters(parametersRaw);
  const params = parsed || {};
  const hasInvalid = parametersRaw.trim().length > 0 && !parsed;

  return (
    <>
      <Hint>Model inputs</Hint>
      {inputs.map((input) => {
        const label = input.label || input.name;
        if (input.type === "boolean") {
          const value = Boolean(resolveInputValue(input, params));
          return (
            <Label key={input.name} className="ui-toggle">
              <Checkbox
                checked={value}
                onChange={(e) =>
                  upsertParameterValue(
                    setParametersRaw,
                    input.name,
                    e.target.checked
                  )
                }
                disabled={disabled}
              />
              {label}
            </Label>
          );
        }
        if (input.type === "select") {
          const value = String(resolveInputValue(input, params));
          return (
            <Label key={input.name}>
              {label}
              <Select
                value={value}
                onChange={(e) =>
                  upsertParameterValue(
                    setParametersRaw,
                    input.name,
                    e.target.value
                  )
                }
                disabled={disabled}
              >
                {(input.options || []).map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>
            </Label>
          );
        }
        if (input.type === "number") {
          const value = resolveInputValue(input, params);
          const valueString = value === "" ? "" : String(value);
          return (
            <Label key={input.name}>
              {label}
              <Input
                type="number"
                value={valueString}
                min={input.min}
                max={input.max}
                step={input.step}
                placeholder={input.placeholder}
                onChange={(e) => {
                  const next =
                    e.target.value === "" ? "" : Number(e.target.value);
                  upsertParameterValue(setParametersRaw, input.name, next);
                }}
                disabled={disabled}
              />
            </Label>
          );
        }
        const value = String(resolveInputValue(input, params));
        if (input.multiline) {
          return (
            <Label key={input.name}>
              {label}
              <Textarea
                rows={2}
                value={value}
                placeholder={input.placeholder}
                onChange={(e) =>
                  upsertParameterValue(
                    setParametersRaw,
                    input.name,
                    e.target.value
                  )
                }
                disabled={disabled}
              />
            </Label>
          );
        }
        return (
          <Label key={input.name}>
            {label}
            <Input
              value={value}
              placeholder={input.placeholder}
              onChange={(e) =>
                upsertParameterValue(
                  setParametersRaw,
                  input.name,
                  e.target.value
                )
              }
              disabled={disabled}
            />
          </Label>
        );
      })}
      {hasInvalid && (
        <Hint>
          Parameters JSON is invalid. Editing model inputs will replace it.
        </Hint>
      )}
    </>
  );
};

const getModelLabel = (model: ModelMetadata | undefined, fallback: string) => {
  return model?.displayName || model?.id || fallback;
};

const isModelAvailable = (model: ModelMetadata | undefined) =>
  model?.available !== false;

const getApiModelLabel = (model: ModelMetadata) => {
  const label = getModelLabel(model, model.id);
  return model.available === false ? `${label} (missing API key)` : label;
};

const findModelById = (
  models: ModelMetadata[],
  provider: string | undefined,
  modelId: string | undefined
) => {
  if (!provider || !modelId) return undefined;
  return models.find(
    (model) => model.provider === provider && model.id === modelId
  );
};

const PROVIDER_KEY_HINTS: Record<string, string> = {
  openai: "AI_KIT_OPENAI_API_KEY or OPENAI_API_KEY",
  anthropic: "AI_KIT_ANTHROPIC_API_KEY or ANTHROPIC_API_KEY",
  google: "AI_KIT_GOOGLE_API_KEY or GOOGLE_API_KEY",
  xai: "AI_KIT_XAI_API_KEY or XAI_API_KEY",
  replicate: "AI_KIT_REPLICATE_API_KEY or REPLICATE_API_TOKEN",
  fal: "AI_KIT_FAL_API_KEY, FAL_API_KEY, or FAL_KEY",
};

const getProviderKeyHint = (provider: string | undefined) => {
  if (!provider) return "";
  const hint = PROVIDER_KEY_HINTS[provider.toLowerCase()];
  if (!hint) return "";
  return `Missing key for ${provider}. Set ${hint}.`;
};

const filterModelsByFamily = (models: ModelMetadata[], family: string) => {
  const familyTagged = models.filter((model) => model.family);
  if (familyTagged.length === 0) {
    return models;
  }
  return models.filter((model) => model.family === family);
};

const groupModelsByProvider = (models: ModelMetadata[]) => {
  const grouped = new Map<string, ModelMetadata[]>();
  for (const model of models) {
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
      }),
    }))
    .sort((a, b) => a.provider.localeCompare(b.provider));
};

const buildApiKey = (provider: string, model: string) =>
  `${provider}::${model}`;

const parseApiKey = (raw: string) => {
  const [provider, model] = raw.split("::");
  return { provider, model };
};
type PipelineSource = "local" | "api";

type PipelineStorage = {
  cutoutSource?: PipelineSource;
  cutoutModel?: string;
  cutoutProvider?: string;
  cutoutApiModel?: string;
  cutoutApiModelOverride?: string;
  cutoutSize?: string;
  cutoutParameters?: string;
  depthSource?: PipelineSource;
  depthModel?: string;
  depthInvert?: boolean;
  depthProvider?: string;
  depthApiModel?: string;
  depthApiModelOverride?: string;
  depthSize?: string;
  depthParameters?: string;
  viewsSource?: PipelineSource;
  viewsModel?: string;
  viewsProvider?: string;
  viewsApiModel?: string;
  viewsApiModelOverride?: string;
  viewsParameters?: string;
  reconSource?: PipelineSource;
  reconMethod?: string;
  reconProvider?: string;
  reconApiModel?: string;
  reconApiModelOverride?: string;
  reconPrompt?: string;
  reconFormat?: string;
  reconParameters?: string;
};

const readPipelineStorage = (): PipelineStorage | null => {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(PIPELINE_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    return parsed as PipelineStorage;
  } catch {
    return null;
  }
};

const writePipelineStorage = (payload: PipelineStorage) => {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(PIPELINE_STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // ignore storage write errors
  }
};

const normalizePipelineSource = (value: unknown): PipelineSource =>
  value === "api" ? "api" : "local";

const formatJobTimestamp = (raw?: string) => {
  if (!raw) return "";
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return "";
  return parsed.toLocaleString();
};

const formatJobLabel = (job: JobStatusResponse) => {
  const timestamp = formatJobTimestamp(job.updatedAt || job.createdAt);
  const shortId = job.id.slice(0, 8);
  if (timestamp) return `${timestamp} | ${shortId}`;
  return job.id;
};

type CreateModelsPanelProps = {
  stageCanvasRef: React.RefObject<HTMLCanvasElement>;
  modelFile: File | null;
  onModelFileChange: (file: File | null) => void;
  canvasLocation: "stage" | "dock";
};

export function CreateModelsPanel({
  stageCanvasRef,
  modelFile,
  onModelFileChange,
  canvasLocation,
}: CreateModelsPanelProps) {
  const viewerRef = useRef<BasicGltfViewer | null>(null);
  const storedPipelineSettings = useMemo(() => readPipelineStorage(), []);

  const [jobId, setJobId] = useState<string | null>(null);
  const [jobIdInput, setJobIdInput] = useState("");
  const [recentJobs, setRecentJobs] = useState<JobStatusResponse[]>([]);
  const [jobsLoading, setJobsLoading] = useState(false);
  const [jobsError, setJobsError] = useState<string | null>(null);
  const [status, setStatus] = useState<string>("idle");
  const [progress, setProgress] = useState<number>(0);
  const [error, setError] = useState<string | null>(null);
  const [models, setModels] = useState<ModelMetadata[]>([]);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [modelsLoaded, setModelsLoaded] = useState(false);
  const [cutoutPreview, setCutoutPreview] = useState<string | null>(null);
  const [viewsManifest, setViewsManifest] = useState<ViewManifest | null>(null);
  const [depthManifest, setDepthManifest] = useState<ViewManifest | null>(null);
  const [depthPreviewImage, setDepthPreviewImage] = useState<string | null>(
    null
  );
  const [depthMaps, setDepthMaps] = useState<Record<string, string>>({});
  const [pointsUrl, setPointsUrl] = useState<string | null>(null);
  const [eventStreamState, setEventStreamState] = useState<
    "idle" | "connecting" | "connected" | "error"
  >("idle");
  const [eventLog, setEventLog] = useState<JobEventEntry[]>([]);
  const [stageProgress, setStageProgress] = useState<Record<string, number>>(
    {}
  );
  const cutoutPreviewRef = useRef<string | null>(null);
  const depthPreviewRef = useRef<string | null>(null);
  const depthMapUrlsRef = useRef<string[]>([]);
  const depthMapsRef = useRef<Record<string, string>>({});
  const pointsLoadedRef = useRef<string | null>(null);
  const artifactsLoadedRef = useRef({
    cutout: false,
    views: false,
    depth: false,
    points: false,
  });
  const eventIdRef = useRef<number>(0);
  const refreshTimerRef = useRef<number | null>(null);
  const statusRef = useRef(status);

  const [cutoutSource, setCutoutSource] = useState<PipelineSource>(() =>
    normalizePipelineSource(storedPipelineSettings?.cutoutSource)
  );
  const [cutoutModel, setCutoutModel] = useState(
    storedPipelineSettings?.cutoutModel || "bria/remove-background"
  );
  const [cutoutProvider, setCutoutProvider] = useState(
    storedPipelineSettings?.cutoutProvider || "replicate"
  );
  const [cutoutApiModel, setCutoutApiModel] = useState(
    storedPipelineSettings?.cutoutApiModel || ""
  );
  const [cutoutApiModelOverride, setCutoutApiModelOverride] = useState(
    storedPipelineSettings?.cutoutApiModelOverride || ""
  );
  const [cutoutPrompt, setCutoutPrompt] = useState(defaultCutoutPrompt);
  const [cutoutSize, setCutoutSize] = useState(
    storedPipelineSettings?.cutoutSize || ""
  );
  const [cutoutParametersRaw, setCutoutParametersRaw] = useState(
    storedPipelineSettings?.cutoutParameters || ""
  );
  const [depthSource, setDepthSource] = useState<PipelineSource>(() =>
    normalizePipelineSource(storedPipelineSettings?.depthSource)
  );
  const [depthModel, setDepthModel] = useState(
    storedPipelineSettings?.depthModel || "chenxwh/depth-anything-v2"
  );
  const [depthProvider, setDepthProvider] = useState(
    storedPipelineSettings?.depthProvider || "replicate"
  );
  const [depthApiModel, setDepthApiModel] = useState(
    storedPipelineSettings?.depthApiModel || ""
  );
  const [depthApiModelOverride, setDepthApiModelOverride] = useState(
    storedPipelineSettings?.depthApiModelOverride || ""
  );
  const [depthPrompt, setDepthPrompt] = useState(defaultDepthPrompt);
  const [depthSize, setDepthSize] = useState(
    storedPipelineSettings?.depthSize || ""
  );
  const [depthParametersRaw, setDepthParametersRaw] = useState(
    storedPipelineSettings?.depthParameters || ""
  );
  const [depthInvertAuto, setDepthInvertAuto] = useState(
    storedPipelineSettings?.depthInvert === undefined
  );
  const [depthInvert, setDepthInvert] = useState(() => {
    if (typeof storedPipelineSettings?.depthInvert === "boolean") {
      return storedPipelineSettings.depthInvert;
    }
    const modelId =
      storedPipelineSettings?.depthModel || "chenxwh/depth-anything-v2";
    return depthModelUsesInverse(modelId);
  });
  const [viewsSource, setViewsSource] = useState<PipelineSource>(() =>
    normalizePipelineSource(storedPipelineSettings?.viewsSource)
  );
  const [viewsModel, setViewsModel] = useState(
    storedPipelineSettings?.viewsModel || "jd7h/zero123plusplus"
  );
  const [viewsProvider, setViewsProvider] = useState(
    storedPipelineSettings?.viewsProvider || "replicate"
  );
  const [viewsApiModel, setViewsApiModel] = useState(
    storedPipelineSettings?.viewsApiModel || ""
  );
  const [viewsApiModelOverride, setViewsApiModelOverride] = useState(
    storedPipelineSettings?.viewsApiModelOverride || ""
  );
  const [viewsPrompt, setViewsPrompt] = useState(defaultViewsPrompt);
  const [viewsParametersRaw, setViewsParametersRaw] = useState(
    storedPipelineSettings?.viewsParameters || ""
  );
  const [reconSource, setReconSource] = useState<PipelineSource>(() =>
    normalizePipelineSource(storedPipelineSettings?.reconSource)
  );
  const [reconMethod, setReconMethod] = useState(
    storedPipelineSettings?.reconMethod || "poisson"
  );
  const [reconProvider, setReconProvider] = useState(
    storedPipelineSettings?.reconProvider || ""
  );
  const [reconApiModel, setReconApiModel] = useState(
    storedPipelineSettings?.reconApiModel || ""
  );
  const [reconApiModelOverride, setReconApiModelOverride] = useState(
    storedPipelineSettings?.reconApiModelOverride || ""
  );
  const [reconPrompt, setReconPrompt] = useState(
    storedPipelineSettings?.reconPrompt || defaultReconPrompt
  );
  const [reconFormat, setReconFormat] = useState(
    storedPipelineSettings?.reconFormat || ""
  );
  const [reconParametersRaw, setReconParametersRaw] = useState(
    storedPipelineSettings?.reconParameters || ""
  );
  const [viewsCount, setViewsCount] = useState(8);
  const [pointsEnabled, setPointsEnabled] = useState(true);
  const [renderMode, setRenderMode] = useState<RenderMode>("mesh");
  const [captionEnabled, setCaptionEnabled] = useState(false);
  const [captionProvider, setCaptionProvider] = useState("openai");
  const [captionModel, setCaptionModel] = useState("gpt-4o-mini");
  const [captionPrompt, setCaptionPrompt] = useState(defaultCaptionPrompt);
  const [rebuildRunning, setRebuildRunning] = useState(false);
  const [rebuildError, setRebuildError] = useState<string | null>(null);
  const [rebuildProgress, setRebuildProgress] = useState(0);

  useEffect(() => {
    const canvas = stageCanvasRef.current;
    if (!canvas) return;

    const viewer = new BasicGltfViewer({ canvas });
    const visualizerControls = defaultParams.global.controls;
    viewer.setControlsOptions({
      screenSpacePanning: true,
      enablePan: visualizerControls.enablePan,
      enableZoom: visualizerControls.enableZoom,
      dampingFactor: visualizerControls.dampingFactor,
      minPolarAngle: 0,
      maxPolarAngle: Math.PI,
      target: [0, 0, 0],
    });
    viewerRef.current = viewer;

    const onResize = () => viewer.resize();
    window.addEventListener("resize", onResize);
    viewer.resize();

    const handleWheel = (event: WheelEvent) => {
      if (event.ctrlKey || event.metaKey) return;
      if (event.deltaMode !== 0) return;
      event.preventDefault();
      viewer.panBy(event.deltaX, event.deltaY);
    };

    canvas.addEventListener("wheel", handleWheel, { passive: false });
    return () => {
      window.removeEventListener("resize", onResize);
      canvas.removeEventListener("wheel", handleWheel);
      viewer.dispose();
      viewerRef.current = null;
    };
  }, [stageCanvasRef]);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    const frame = window.requestAnimationFrame(() => {
      viewer.resize();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [canvasLocation]);

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
    artifactsLoadedRef.current = {
      cutout: false,
      views: false,
      depth: false,
      points: false,
    };
    depthMapsRef.current = {};
    for (const url of depthMapUrlsRef.current) {
      URL.revokeObjectURL(url);
    }
    depthMapUrlsRef.current = [];
    pointsLoadedRef.current = null;
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
    setPointsUrl(null);
  }, [jobId]);

  useEffect(() => {
    if (!jobId) return;
    setJobIdInput(jobId);
  }, [jobId]);

  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  useEffect(() => {
    depthMapsRef.current = depthMaps;
  }, [depthMaps]);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || status !== "done") return;
    viewer.setRenderMode(renderMode);
    if (
      renderMode === "points" &&
      pointsUrl &&
      pointsLoadedRef.current !== pointsUrl
    ) {
      pointsLoadedRef.current = pointsUrl;
      viewer.loadPointCloud(pointsUrl).catch(() => {
        pointsLoadedRef.current = null;
      });
    }
  }, [renderMode, pointsUrl, status]);

  useEffect(() => {
    let cancelled = false;
    const loadModels = async () => {
      try {
        const data = await client.listProviderModels({ allowFallback: false });
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
    () =>
      models.filter(
        (model) => model.provider !== "catalog" && model.capabilities?.vision
      ),
    [models]
  );
  const imageModels = useMemo(
    () =>
      models.filter(
        (model) => model.provider !== "catalog" && model.capabilities?.image
      ),
    [models]
  );
  const availableVisionModels = useMemo(
    () => visionModels.filter((model) => isModelAvailable(model)),
    [visionModels]
  );
  const availableImageModels = useMemo(
    () => imageModels.filter((model) => isModelAvailable(model)),
    [imageModels]
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
  const visionProviderOptions = useMemo(() => {
    return Array.from(
      new Set(visionModels.map((model) => model.provider))
    ).sort();
  }, [visionModels]);
  const availableVisionProviderOptions = useMemo(() => {
    return Array.from(
      new Set(availableVisionModels.map((model) => model.provider))
    ).sort();
  }, [availableVisionModels]);
  const imageProviderOptions = useMemo(() => {
    return Array.from(
      new Set(imageModels.map((model) => model.provider))
    ).sort();
  }, [imageModels]);
  const availableImageProviderOptions = useMemo(() => {
    return Array.from(
      new Set(availableImageModels.map((model) => model.provider))
    ).sort();
  }, [availableImageModels]);
  const cutoutApiModels = useMemo(
    () => filterModelsByFamily(imageModels, "cutout"),
    [imageModels]
  );
  const depthApiModels = useMemo(
    () => filterModelsByFamily(imageModels, "depth"),
    [imageModels]
  );
  const viewsApiModels = useMemo(
    () => filterModelsByFamily(imageModels, "views"),
    [imageModels]
  );
  const reconApiModels = useMemo(
    () =>
      models.filter(
        (model) => model.provider !== "catalog" && model.family === "recon"
      ),
    [models]
  );
  const availableReconApiModels = useMemo(
    () => reconApiModels.filter((model) => isModelAvailable(model)),
    [reconApiModels]
  );
  const reconProviderOptions = useMemo(() => {
    return Array.from(
      new Set(reconApiModels.map((model) => model.provider))
    ).sort();
  }, [reconApiModels]);
  const availableReconProviderOptions = useMemo(() => {
    return Array.from(
      new Set(availableReconApiModels.map((model) => model.provider))
    ).sort();
  }, [availableReconApiModels]);
  const availableCutoutProviderModels = useMemo(() => {
    return filterModelsByFamily(
      availableImageModels.filter((model) => model.provider === cutoutProvider),
      "cutout"
    );
  }, [availableImageModels, cutoutProvider]);
  const availableDepthProviderModels = useMemo(() => {
    return filterModelsByFamily(
      availableImageModels.filter((model) => model.provider === depthProvider),
      "depth"
    );
  }, [availableImageModels, depthProvider]);
  const availableViewsProviderModels = useMemo(() => {
    return filterModelsByFamily(
      availableImageModels.filter((model) => model.provider === viewsProvider),
      "views"
    );
  }, [availableImageModels, viewsProvider]);
  const availableReconProviderModels = useMemo(() => {
    return availableReconApiModels.filter(
      (model) => model.provider === reconProvider
    );
  }, [availableReconApiModels, reconProvider]);
  const availableProviderModels = useMemo(() => {
    return availableVisionModels.filter(
      (model) => model.provider === captionProvider
    );
  }, [availableVisionModels, captionProvider]);
  const apiModelGroups = useMemo(() => {
    return groupModelsByProvider(visionModels);
  }, [visionModels]);
  const cutoutApiModelGroups = useMemo(
    () => groupModelsByProvider(cutoutApiModels),
    [cutoutApiModels]
  );
  const depthApiModelGroups = useMemo(
    () => groupModelsByProvider(depthApiModels),
    [depthApiModels]
  );
  const viewsApiModelGroups = useMemo(
    () => groupModelsByProvider(viewsApiModels),
    [viewsApiModels]
  );
  const reconApiModelGroups = useMemo(
    () => groupModelsByProvider(reconApiModels),
    [reconApiModels]
  );
  const isCutoutProviderAvailable =
    availableImageProviderOptions.includes(cutoutProvider);
  const isDepthProviderAvailable =
    availableImageProviderOptions.includes(depthProvider);
  const isViewsProviderAvailable =
    availableImageProviderOptions.includes(viewsProvider);
  const isReconProviderAvailable =
    availableReconProviderOptions.includes(reconProvider);
  const isCaptionProviderAvailable =
    availableVisionProviderOptions.includes(captionProvider);
  const cutoutProviderHint = getProviderKeyHint(cutoutProvider);
  const depthProviderHint = getProviderKeyHint(depthProvider);
  const viewsProviderHint = getProviderKeyHint(viewsProvider);
  const reconProviderHint = getProviderKeyHint(reconProvider);
  const captionProviderHint = getProviderKeyHint(captionProvider);
  const cutoutProviderValue = isCutoutProviderAvailable ? cutoutProvider : "";
  const cutoutApiModelValue =
    cutoutApiModelOverride.trim() ||
    (isCutoutProviderAvailable && availableCutoutProviderModels.length > 0
      ? cutoutApiModel
      : "");
  const depthProviderValue = isDepthProviderAvailable ? depthProvider : "";
  const depthApiModelValue =
    depthApiModelOverride.trim() ||
    (isDepthProviderAvailable && availableDepthProviderModels.length > 0
      ? depthApiModel
      : "");
  const viewsProviderValue = isViewsProviderAvailable ? viewsProvider : "";
  const viewsApiModelValue =
    viewsApiModelOverride.trim() ||
    (isViewsProviderAvailable && availableViewsProviderModels.length > 0
      ? viewsApiModel
      : "");
  const selectedViewsModelId =
    viewsSource === "api" ? viewsApiModelValue : viewsModelValue;
  const isZero123ppViews =
    !!selectedViewsModelId && viewsModelUsesFixedViews(selectedViewsModelId);
  const reconProviderValue = isReconProviderAvailable ? reconProvider : "";
  const reconApiModelValue =
    reconApiModelOverride.trim() ||
    (isReconProviderAvailable && availableReconProviderModels.length > 0
      ? reconApiModel
      : "");
  const captionProviderValue = isCaptionProviderAvailable
    ? captionProvider
    : "";
  const captionModelValue =
    isCaptionProviderAvailable && availableProviderModels.length > 0
      ? captionModel
      : "";
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
  const reconApiSelection =
    reconProviderValue && reconApiModelValue
      ? buildApiKey(reconProviderValue, reconApiModelValue)
      : "";
  const captionSelection =
    captionProviderValue && captionModelValue
      ? buildApiKey(captionProviderValue, captionModelValue)
      : "";
  const selectedCutoutModel = useMemo(() => {
    if (cutoutSource === "local") {
      return findModelById(models, "catalog", cutoutModel);
    }
    return findModelById(models, cutoutProviderValue, cutoutApiModelValue);
  }, [
    models,
    cutoutSource,
    cutoutModel,
    cutoutProviderValue,
    cutoutApiModelValue,
  ]);
  const selectedViewsModel = useMemo(() => {
    if (viewsSource === "local") {
      return findModelById(models, "catalog", viewsModelValue);
    }
    return findModelById(models, viewsProviderValue, viewsApiModelValue);
  }, [
    models,
    viewsSource,
    viewsModelValue,
    viewsProviderValue,
    viewsApiModelValue,
  ]);
  const selectedDepthModel = useMemo(() => {
    if (depthSource === "local") {
      return findModelById(models, "catalog", depthModel);
    }
    return findModelById(models, depthProviderValue, depthApiModelValue);
  }, [models, depthSource, depthModel, depthProviderValue, depthApiModelValue]);
  const selectedReconModel = useMemo(() => {
    if (reconSource === "local") {
      return undefined;
    }
    return findModelById(models, reconProviderValue, reconApiModelValue);
  }, [models, reconSource, reconProviderValue, reconApiModelValue]);
  const apiSelectionError = useMemo(() => {
    const missing = [];
    if (
      cutoutSource === "api" &&
      (!cutoutProviderValue || !cutoutApiModelValue)
    ) {
      missing.push("Cutout");
    }
    if (depthSource === "api" && (!depthProviderValue || !depthApiModelValue)) {
      missing.push("Depth");
    }
    if (viewsSource === "api" && (!viewsProviderValue || !viewsApiModelValue)) {
      missing.push("Views");
    }
    if (reconSource === "api" && (!reconProviderValue || !reconApiModelValue)) {
      missing.push("Recon");
    }
    if (captionEnabled && (!captionProviderValue || !captionModelValue)) {
      missing.push("Caption");
    }
    if (missing.length === 0) return "";
    return `${missing.join(", ")} API selection missing provider/model.`;
  }, [
    cutoutSource,
    cutoutProviderValue,
    cutoutApiModelValue,
    depthSource,
    depthProviderValue,
    depthApiModelValue,
    viewsSource,
    viewsProviderValue,
    viewsApiModelValue,
    reconSource,
    reconProviderValue,
    reconApiModelValue,
    captionEnabled,
    captionProviderValue,
    captionModelValue,
  ]);
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
      const imageName = view.image_path
        ? getBasename(view.image_path)
        : `${id}.png`;
      return {
        id,
        label: id.replace(/^view_/, "View "),
        url: getArtifactUrl(`views/${imageName}`),
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
        depthUrl: depthName ? getArtifactUrl(`depth/${depthName}`) : "",
      };
    });
  }, [depthManifest, getArtifactUrl]);
  const stageProgressItems = useMemo(
    () =>
      PIPELINE_STAGES.map((stage) => ({
        stage,
        progress: stageProgress[stage],
      })).filter((item) => typeof item.progress === "number"),
    [stageProgress]
  );

  useEffect(() => {
    if (!availableVisionModels.length) return;
    if (
      !availableVisionModels.some((model) => model.provider === captionProvider)
    ) {
      setCaptionProvider(availableVisionModels[0].provider);
    }
  }, [availableVisionModels, captionProvider]);

  useEffect(() => {
    if (!availableImageModels.length) return;
    if (
      !availableImageModels.some((model) => model.provider === cutoutProvider)
    ) {
      setCutoutProvider(availableImageModels[0].provider);
    }
  }, [availableImageModels, cutoutProvider]);

  useEffect(() => {
    if (!availableImageModels.length) return;
    if (
      !availableImageModels.some((model) => model.provider === depthProvider)
    ) {
      setDepthProvider(availableImageModels[0].provider);
    }
  }, [availableImageModels, depthProvider]);

  useEffect(() => {
    if (!availableImageModels.length) return;
    if (
      !availableImageModels.some((model) => model.provider === viewsProvider)
    ) {
      setViewsProvider(availableImageModels[0].provider);
    }
  }, [availableImageModels, viewsProvider]);

  useEffect(() => {
    if (!availableReconApiModels.length) return;
    if (
      !availableReconApiModels.some((model) => model.provider === reconProvider)
    ) {
      setReconProvider(availableReconApiModels[0].provider);
    }
  }, [availableReconApiModels, reconProvider]);

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
    if (!depthInvertAuto || depthSource !== "local") return;
    const recommended = depthModelUsesInverse(depthModel);
    if (depthInvert !== recommended) {
      setDepthInvert(recommended);
    }
  }, [depthInvertAuto, depthInvert, depthModel, depthSource]);

  useEffect(() => {
    if (!viewsOptions.length) return;
    if (!viewsOptions.some((model) => model.id === viewsModel)) {
      setViewsModel(viewsOptions[0].id);
    }
  }, [viewsOptions, viewsModel]);

  useEffect(() => {
    if (!availableCutoutProviderModels.length) return;
    if (
      !availableCutoutProviderModels.some(
        (model) => model.id === cutoutApiModel
      )
    ) {
      setCutoutApiModel(availableCutoutProviderModels[0].id);
    }
  }, [availableCutoutProviderModels, cutoutApiModel]);

  useEffect(() => {
    const override = cutoutApiModelOverride.trim();
    if (!override) return;
    if (!availableCutoutProviderModels.some((model) => model.id === override)) {
      setCutoutApiModelOverride("");
    }
  }, [availableCutoutProviderModels, cutoutApiModelOverride]);

  useEffect(() => {
    if (!availableDepthProviderModels.length) return;
    if (
      !availableDepthProviderModels.some((model) => model.id === depthApiModel)
    ) {
      setDepthApiModel(availableDepthProviderModels[0].id);
    }
  }, [availableDepthProviderModels, depthApiModel]);

  useEffect(() => {
    const override = depthApiModelOverride.trim();
    if (!override) return;
    if (!availableDepthProviderModels.some((model) => model.id === override)) {
      setDepthApiModelOverride("");
    }
  }, [availableDepthProviderModels, depthApiModelOverride]);

  useEffect(() => {
    if (!availableViewsProviderModels.length) return;
    if (
      !availableViewsProviderModels.some((model) => model.id === viewsApiModel)
    ) {
      setViewsApiModel(availableViewsProviderModels[0].id);
    }
  }, [availableViewsProviderModels, viewsApiModel]);

  useEffect(() => {
    if (!isZero123ppViews) return;
    if (viewsCount !== 6) {
      setViewsCount(6);
    }
  }, [isZero123ppViews, viewsCount]);

  useEffect(() => {
    const override = viewsApiModelOverride.trim();
    if (!override) return;
    if (!availableViewsProviderModels.some((model) => model.id === override)) {
      setViewsApiModelOverride("");
    }
  }, [availableViewsProviderModels, viewsApiModelOverride]);

  useEffect(() => {
    if (!availableReconProviderModels.length) return;
    if (
      !availableReconProviderModels.some((model) => model.id === reconApiModel)
    ) {
      setReconApiModel(availableReconProviderModels[0].id);
    }
  }, [availableReconProviderModels, reconApiModel]);

  useEffect(() => {
    const override = reconApiModelOverride.trim();
    if (!override) return;
    if (!availableReconProviderModels.some((model) => model.id === override)) {
      setReconApiModelOverride("");
    }
  }, [availableReconProviderModels, reconApiModelOverride]);

  useEffect(() => {
    if (!availableProviderModels.length) return;
    if (!availableProviderModels.some((model) => model.id === captionModel)) {
      setCaptionModel(availableProviderModels[0].id);
    }
  }, [availableProviderModels, captionModel]);

  useEffect(() => {
    writePipelineStorage({
      cutoutSource,
      cutoutModel,
      cutoutProvider,
      cutoutApiModel,
      cutoutApiModelOverride,
      cutoutSize,
      cutoutParameters: cutoutParametersRaw,
      depthSource,
      depthModel,
      depthInvert,
      depthProvider,
      depthApiModel,
      depthApiModelOverride,
      depthSize,
      depthParameters: depthParametersRaw,
      viewsSource,
      viewsModel,
      viewsProvider,
      viewsApiModel,
      viewsApiModelOverride,
      viewsParameters: viewsParametersRaw,
      reconSource,
      reconMethod,
      reconProvider,
      reconApiModel,
      reconApiModelOverride,
      reconPrompt,
      reconFormat,
      reconParameters: reconParametersRaw,
    });
  }, [
    cutoutSource,
    cutoutModel,
    cutoutProvider,
    cutoutApiModel,
    cutoutApiModelOverride,
    cutoutSize,
    cutoutParametersRaw,
    depthSource,
    depthModel,
    depthInvert,
    depthProvider,
    depthApiModel,
    depthApiModelOverride,
    depthSize,
    depthParametersRaw,
    viewsSource,
    viewsModel,
    viewsProvider,
    viewsApiModel,
    viewsApiModelOverride,
    viewsParametersRaw,
    reconSource,
    reconMethod,
    reconProvider,
    reconApiModel,
    reconApiModelOverride,
    reconPrompt,
    reconFormat,
    reconParametersRaw,
  ]);

  const loadRecentJobs = useCallback(async () => {
    setJobsLoading(true);
    setJobsError(null);
    try {
      const items = await client.listJobs({ status: "done", limit: 12 });
      setRecentJobs(items);
    } catch (err: any) {
      setJobsError(String(err?.message || err));
    } finally {
      setJobsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadRecentJobs();
  }, [loadRecentJobs]);

  useEffect(() => {
    if (!jobIdInput && recentJobs.length > 0) {
      setJobIdInput(recentJobs[0].id);
    }
  }, [jobIdInput, recentJobs]);

  useEffect(() => {
    if (status !== "done") return;
    loadRecentJobs();
  }, [status, loadRecentJobs]);

  const refreshArtifacts = useCallback(async () => {
    if (!artifactBase) return;

    if (!artifactsLoadedRef.current.cutout) {
      try {
        const res = await fetch(getArtifactUrl("cutout.png"), {
          cache: "no-store",
        });
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
        const res = await fetch(getArtifactUrl("views.json"), {
          cache: "no-store",
        });
        if (res.ok) {
          const raw = await res.text();
          const manifest = safeParseJson(raw);
          if (
            manifest &&
            Array.isArray(manifest.views) &&
            manifest.views.length > 0
          ) {
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
        const res = await fetch(getArtifactUrl("depth.json"), {
          cache: "no-store",
        });
        if (res.ok) {
          const contentType = res.headers.get("content-type") ?? "";
          if (
            contentType.includes("application/json") ||
            contentType.includes("text/")
          ) {
            const raw = await res.text();
            const manifest = safeParseJson(raw);
            if (
              manifest &&
              Array.isArray(manifest.views) &&
              manifest.views.some((view: ViewManifestEntry) =>
                Boolean(view.depth_path)
              )
            ) {
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

    if (!artifactsLoadedRef.current.points) {
      try {
        const res = await fetch(getArtifactUrl("points.ply"), {
          method: "HEAD",
          cache: "no-store",
        });
        if (res.ok) {
          setPointsUrl(getArtifactUrl("points.ply"));
          artifactsLoadedRef.current.points = true;
        }
      } catch {
        // ignore
      }
    }
  }, [artifactBase, getArtifactUrl]);

  const scheduleArtifactRefresh = useCallback(() => {
    if (!artifactBase) return;
    if (refreshTimerRef.current) return;
    refreshTimerRef.current = window.setTimeout(() => {
      refreshTimerRef.current = null;
      refreshArtifacts();
    }, 250);
  }, [artifactBase, refreshArtifacts]);

  useEffect(() => {
    if (depthItems.length === 0) return;
    let cancelled = false;

    const loadDepthMaps = async () => {
      for (const item of depthItems) {
        if (!item.depthUrl || depthMapsRef.current[item.id]) continue;
        try {
          const res = await fetch(item.depthUrl, { cache: "no-store" });
          if (!res.ok) continue;
          const contentType = res.headers.get("content-type") ?? "";
          if (
            contentType.includes("image/") ||
            item.depthUrl.endsWith(".png")
          ) {
            const blob = await res.blob();
            const url = URL.createObjectURL(blob);
            depthMapUrlsRef.current.push(url);
            if (!cancelled) {
              setDepthMaps((prev) => ({ ...prev, [item.id]: url }));
            }
            continue;
          }
          const buffer = await res.arrayBuffer();
          const { data, shape } = parseNpyFloat32(buffer);
          const preview = buildDepthPreview(
            data,
            shape,
            item.depthMin,
            item.depthMax
          );
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
    if (!modelFile) return;
    if (!modelsLoaded) {
      setError("Model list still loading.");
      return;
    }
    if (modelsError) {
      setError(`Model list error: ${modelsError}`);
      return;
    }
    if (apiSelectionError) {
      setError(apiSelectionError);
      return;
    }

    const useCutoutApi =
      cutoutSource === "api" && cutoutProviderValue && cutoutApiModelValue;
    const useDepthApi =
      depthSource === "api" && depthProviderValue && depthApiModelValue;
    const useViewsApi =
      viewsSource === "api" && viewsProviderValue && viewsApiModelValue;
    const useReconApi =
      reconSource === "api" && reconProviderValue && reconApiModelValue;
    const cutoutParameters = parseParameters(cutoutParametersRaw);
    if (cutoutParametersRaw.trim() && !cutoutParameters) {
      setError("Cutout parameters must be valid JSON.");
      return;
    }
    const depthParameters = parseParameters(depthParametersRaw);
    if (depthParametersRaw.trim() && !depthParameters) {
      setError("Depth parameters must be valid JSON.");
      return;
    }
    const viewsParameters = parseParameters(viewsParametersRaw);
    if (viewsParametersRaw.trim() && !viewsParameters) {
      setError("View parameters must be valid JSON.");
      return;
    }
    const reconParameters =
      reconSource === "api" ? parseParameters(reconParametersRaw) : null;
    if (
      reconSource === "api" &&
      reconParametersRaw.trim() &&
      !reconParameters
    ) {
      setError("Recon parameters must be valid JSON.");
      return;
    }

    const cutoutConfig = useCutoutApi
      ? {
          provider: cutoutProviderValue,
          model: cutoutApiModelValue,
          prompt: cutoutPrompt,
          size: cutoutSize || undefined,
          parameters: cutoutParameters || undefined,
        }
      : {
          model: cutoutModel,
          prompt: cutoutPrompt,
          size: cutoutSize || undefined,
          parameters: cutoutParameters || undefined,
        };
    const depthConfig = useDepthApi
      ? {
          provider: depthProviderValue,
          model: depthApiModelValue,
          prompt: depthPrompt,
          size: depthSize || undefined,
          parameters: depthParameters || undefined,
        }
      : {
          model: depthModel,
          prompt: depthPrompt,
          depthInvert,
          size: depthSize || undefined,
          parameters: depthParameters || undefined,
        };
    const viewsConfig: Record<string, unknown> = {
      count: viewsCount,
      prompt: viewsPrompt,
      parameters: viewsParameters || undefined,
    };
    if (useViewsApi) {
      viewsConfig.provider = viewsProviderValue;
      viewsConfig.model = viewsApiModelValue;
    } else if (viewsModelValue) {
      viewsConfig.model = viewsModelValue;
    }

    const reconConfig: Record<string, unknown> = {
      points: {
        enabled: pointsEnabled,
      },
    };
    if (useReconApi) {
      reconConfig.provider = reconProviderValue;
      reconConfig.model = reconApiModelValue;
      reconConfig.prompt = reconPrompt;
      if (reconFormat.trim()) {
        reconConfig.format = reconFormat.trim();
      }
    } else {
      reconConfig.method = reconMethod;
    }

    const bakeSpec = BakeSpecSchema.parse({
      version: "0.1.0",
      cutout: cutoutConfig,
      depth: depthConfig,
      views: viewsConfig,
      recon: reconConfig,
      mesh: { targetTris: 2000 },
      ai: {
        caption: {
          enabled: captionEnabled,
          provider: captionProvider,
          model: captionModel,
          prompt: captionPrompt,
        },
      },
    });

    setStatus("uploading");
    const pipelineConfig: Record<string, unknown> = {};
    if (cutoutParameters) pipelineConfig.remove_bg_params = cutoutParameters;
    if (depthParameters) pipelineConfig.depth_params = depthParameters;
    if (viewsParameters) pipelineConfig.multiview_params = viewsParameters;

    const hasPipelineConfig = Object.keys(pipelineConfig).length > 0;
    const { jobId } = await client.createJob({
      image: modelFile,
      bakeSpec,
      pipelineConfig: hasPipelineConfig ? pipelineConfig : undefined,
    });
    setJobId(jobId);
    setStatus("queued");
  }

  const loadJob = useCallback(() => {
    const trimmed = jobIdInput.trim();
    if (!trimmed) return;
    setError(null);
    setProgress(0);
    setStatus("loading");
    setJobId(trimmed);
  }, [jobIdInput]);

  const selectedRecentJobId = recentJobs.some((job) => job.id === jobIdInput)
    ? jobIdInput
    : "";
  const canRebuild =
    Boolean(jobId) && status === "done" && reconSource === "local";

  useEffect(() => {
    if (!jobId) return;
    let cancelled = false;
    let eventSource: EventSource | null = null;
    let pollTimer: number | null = null;
    let done = false;
    let streamReady = false;

    setError(null);
    setEventStreamState("connecting");
    setEventLog([]);
    setStageProgress({});
    setRebuildProgress(0);
    eventIdRef.current = 0;

    const stopPolling = () => {
      if (pollTimer) {
        window.clearTimeout(pollTimer);
        pollTimer = null;
      }
    };

    const handleDone = async () => {
      if (done) return;
      done = true;
      setStatus("done");
      setProgress(1);
      await refreshArtifacts();
      const url = client.getResultUrl(jobId);
      await viewerRef.current?.load(url, { renderMode });
    };

    const handleFailed = (message?: string) => {
      done = true;
      setStatus("error");
      setError(message || "unknown error");
    };

    const handleJobPoll = async () => {
      try {
        const j = await client.getJob(jobId);
        if (cancelled) return;
        setStatus(j.status);
        setProgress(j.progress);
        if (j.status === "done") {
          await handleDone();
          return;
        }
        if (j.status === "error") {
          handleFailed(j.error);
          return;
        }
      } catch (e: any) {
        setError(String(e?.message || e));
      }
      if (!cancelled && !done && !streamReady) {
        pollTimer = window.setTimeout(handleJobPoll, 3000);
      }
    };

    const handleStreamEvent = (payload: JobEventPayload) => {
      if (!payload || typeof payload !== "object") return;
      const event = payload.event;
      if (!event || typeof event !== "object") return;
      const sort = Number(payload.sort || eventIdRef.current + 1);
      eventIdRef.current = Math.max(eventIdRef.current, sort);
      const kind = event.kind || "event";
      const stage = event.stage || "pipeline";
      const message = event.message;
      const progressValue =
        typeof event.progress === "number" ? event.progress : undefined;
      const artifactName = event.artifact?.name;

      setEventLog((prev) => {
        const next = [
          {
            id: sort,
            kind,
            stage,
            message,
            progress: progressValue,
            artifactName,
          },
          ...prev,
        ];
        return next.slice(0, 12);
      });

      if (kind === "progress" && typeof progressValue === "number") {
        if (stage === "rebuild") {
          setRebuildProgress(progressValue);
          return;
        }
        setStageProgress((prev) => ({ ...prev, [stage]: progressValue }));
        if (stage === "overall") {
          setProgress(progressValue);
          if (
            statusRef.current === "queued" ||
            statusRef.current === "loading"
          ) {
            setStatus("running");
          }
        }
      }

      if (kind === "artifact" && artifactName) {
        scheduleArtifactRefresh();
      }

      if (kind === "status") {
        if (stage === "done") {
          handleDone();
        } else if (stage === "failed") {
          handleFailed(message);
        }
      }
    };

    handleJobPoll();

    if (typeof EventSource !== "undefined") {
      const url = `${API_BASE_URL}/v1/jobs/${jobId}/events`;
      eventSource = new EventSource(url);
      eventSource.onopen = () => {
        setEventStreamState("connected");
        streamReady = true;
        stopPolling();
      };
      eventSource.onerror = () => {
        if (cancelled) return;
        setEventStreamState("error");
        streamReady = false;
        if (!done) {
          stopPolling();
          handleJobPoll();
        }
      };
      eventSource.addEventListener("job", (evt) => {
        const data =
          typeof evt.data === "string" ? safeParseJson(evt.data) : null;
        if (data) {
          handleStreamEvent(data as JobEventPayload);
        }
      });
    } else {
      setEventStreamState("idle");
    }

    return () => {
      cancelled = true;
      stopPolling();
      if (eventSource) {
        eventSource.close();
      }
    };
  }, [jobId, refreshArtifacts, renderMode, scheduleArtifactRefresh]);

  const rebuildRecon = useCallback(async () => {
    if (!jobId || !canRebuild || rebuildRunning) return;
    setRebuildRunning(true);
    setRebuildError(null);
    setRebuildProgress(0);
    try {
      const payload = {
        pipelineConfig: {
          recon_method: reconMethod,
          recon_images: viewsCount,
          recon_target_tris: 2000,
          points_enabled: pointsEnabled,
        },
      };
      const res = await fetch(`${API_BASE_URL}/v1/jobs/${jobId}/recon`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const detail = await res.text();
        throw new Error(detail || `Rebuild failed: ${res.status}`);
      }
      artifactsLoadedRef.current.points = false;
      pointsLoadedRef.current = null;
      setPointsUrl(null);
      await refreshArtifacts();
      const url = client.getResultUrl(jobId);
      await viewerRef.current?.load(url, { renderMode });
      setRebuildProgress(1);
    } catch (err: any) {
      setRebuildError(String(err?.message || err));
      setRebuildProgress(0);
    } finally {
      setRebuildRunning(false);
    }
  }, [
    jobId,
    canRebuild,
    rebuildRunning,
    reconMethod,
    viewsCount,
    pointsEnabled,
    refreshArtifacts,
    renderMode,
  ]);

  return (
    <div className="hudPanelStack">
      <Panel className="hudPanel">
        <PanelTitle>Model Forge</PanelTitle>
        <Label>
          Image file
          <Input
            type="file"
            accept="image/*"
            onChange={(e) => onModelFileChange(e.target.files?.[0] || null)}
          />
        </Label>
        <Status>
          {modelFile ? `Selected: ${modelFile.name}` : "No image selected"}
        </Status>

        <Group>
          <GroupTitle>Load existing job</GroupTitle>
          <Label>
            Completed jobs
            <Select
              value={selectedRecentJobId}
              onChange={(e) => setJobIdInput(e.target.value)}
              disabled={recentJobs.length === 0}
            >
              <option value="">
                {recentJobs.length === 0
                  ? "No completed jobs yet"
                  : "Select a job"}
              </option>
              {recentJobs.map((job) => (
                <option key={job.id} value={job.id}>
                  {formatJobLabel(job)}
                </option>
              ))}
            </Select>
          </Label>
          <Label>
            Or paste job ID
            <Input
              type="text"
              value={jobIdInput}
              placeholder="Paste a job id"
              onChange={(e) => setJobIdInput(e.target.value)}
            />
          </Label>
          <div className="hudControlRow">
            <Button onClick={loadJob} disabled={!jobIdInput.trim()}>
              Load job
            </Button>
            <Button
              onClick={loadRecentJobs}
              disabled={jobsLoading}
              variant="ghost"
            >
              {jobsLoading ? "Refreshing..." : "Refresh list"}
            </Button>
          </div>
          <Hint>Load a previous job to restore its artifacts and preview.</Hint>
          {jobsError && <Hint>Job list error: {jobsError}</Hint>}
        </Group>

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
                <div
                  className="hudSourceToggle"
                  role="radiogroup"
                  aria-label="Cutout source"
                >
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
                    disabled={availableImageProviderOptions.length === 0}
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
                      applyApiSelection(
                        e.target.value,
                        setCutoutProvider,
                        setCutoutApiModel
                      );
                    }
                  }}
                  disabled={
                    cutoutSource === "local"
                      ? cutoutOptions.length === 0
                      : cutoutApiModelGroups.length === 0
                  }
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
                  ) : cutoutApiModelGroups.length === 0 ? (
                    <option value="">No models available</option>
                  ) : (
                    cutoutApiModelGroups.map((group) => (
                      <optgroup key={group.provider} label={group.provider}>
                        {group.models.map((model) => (
                          <option
                            key={`${group.provider}:${model.id}`}
                            value={buildApiKey(group.provider, model.id)}
                            disabled={
                              !isModelAvailable(model) ||
                              !availableImageProviderOptions.includes(
                                group.provider
                              )
                            }
                          >
                            {getApiModelLabel(model)}
                          </option>
                        ))}
                      </optgroup>
                    ))
                  )}
                </Select>
              </Label>
              {cutoutSource === "api" &&
                !isCutoutProviderAvailable &&
                cutoutProviderHint && <Hint>{cutoutProviderHint}</Hint>}
              <Label>
                Custom API model id
                <Input
                  placeholder="space:owner/name or endpoint:https://..."
                  value={cutoutApiModelOverride}
                  onChange={(e) => setCutoutApiModelOverride(e.target.value)}
                  disabled={cutoutSource !== "api"}
                />
              </Label>
              <Label>
                Prompt
                <Textarea
                  rows={2}
                  value={cutoutPrompt}
                  onChange={(e) => setCutoutPrompt(e.target.value)}
                />
              </Label>
              <Label>
                Size (WxH)
                <Input
                  placeholder="1024x1024"
                  value={cutoutSize}
                  onChange={(e) => setCutoutSize(e.target.value)}
                />
              </Label>
              <ModelInputsEditor
                inputs={selectedCutoutModel?.inputs}
                parametersRaw={cutoutParametersRaw}
                setParametersRaw={setCutoutParametersRaw}
                disabled={cutoutSource === "api" && !cutoutProviderValue}
              />
              <Label>
                Parameters (JSON)
                <Textarea
                  rows={2}
                  value={cutoutParametersRaw}
                  onChange={(e) => setCutoutParametersRaw(e.target.value)}
                  placeholder='{"mask_threshold": 0.5}'
                />
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
                <div
                  className="hudSourceToggle"
                  role="radiogroup"
                  aria-label="View source"
                >
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
                    disabled={availableImageProviderOptions.length === 0}
                  >
                    API
                  </button>
                </div>
              </div>
              <Label>
                Model
                <Select
                  value={
                    viewsSource === "local"
                      ? viewsModelValue
                      : viewsApiSelection
                  }
                  onChange={(e) => {
                    if (viewsSource === "local") {
                      setViewsModel(e.target.value);
                    } else {
                      applyApiSelection(
                        e.target.value,
                        setViewsProvider,
                        setViewsApiModel
                      );
                    }
                  }}
                  disabled={
                    viewsSource === "local"
                      ? viewsOptions.length === 0
                      : viewsApiModelGroups.length === 0
                  }
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
                  ) : viewsApiModelGroups.length === 0 ? (
                    <option value="">No models available</option>
                  ) : (
                    viewsApiModelGroups.map((group) => (
                      <optgroup key={group.provider} label={group.provider}>
                        {group.models.map((model) => (
                          <option
                            key={`${group.provider}:${model.id}`}
                            value={buildApiKey(group.provider, model.id)}
                            disabled={
                              !isModelAvailable(model) ||
                              !availableImageProviderOptions.includes(
                                group.provider
                              )
                            }
                          >
                            {getApiModelLabel(model)}
                          </option>
                        ))}
                      </optgroup>
                    ))
                  )}
                </Select>
              </Label>
              {viewsSource === "api" &&
                !isViewsProviderAvailable &&
                viewsProviderHint && <Hint>{viewsProviderHint}</Hint>}
              <Label>
                Custom API model id
                <Input
                  placeholder="space:owner/name or endpoint:https://..."
                  value={viewsApiModelOverride}
                  onChange={(e) => setViewsApiModelOverride(e.target.value)}
                  disabled={viewsSource !== "api"}
                />
              </Label>
              <Label>
                Prompt
                <Textarea
                  rows={2}
                  value={viewsPrompt}
                  onChange={(e) => setViewsPrompt(e.target.value)}
                />
              </Label>
              <ModelInputsEditor
                inputs={selectedViewsModel?.inputs}
                parametersRaw={viewsParametersRaw}
                setParametersRaw={setViewsParametersRaw}
                disabled={viewsSource === "api" && !viewsProviderValue}
              />
              <Label>
                Parameters (JSON)
                <Textarea
                  rows={2}
                  value={viewsParametersRaw}
                  onChange={(e) => setViewsParametersRaw(e.target.value)}
                  placeholder='{"__hf_api_name": "/predict", "__hf_inputs": ["{image}", "{prompt}", "{az_deg}", "{elev_deg}"]}'
                />
              </Label>
              {isZero123ppViews ? (
                <Label className="hudSlider">View count: 6</Label>
              ) : (
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
              )}
            </div>

            <div className="hudPipelineStage">
              <div className="hudPipelineHeader">
                <div>
                  <div className="hudPipelineTitle">Depth</div>
                  <div className="hudPipelineMeta">
                    {depthSource === "local" ? "Catalog model" : "API model"}
                  </div>
                </div>
                <div
                  className="hudSourceToggle"
                  role="radiogroup"
                  aria-label="Depth source"
                >
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
                    disabled={availableImageProviderOptions.length === 0}
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
                      applyApiSelection(
                        e.target.value,
                        setDepthProvider,
                        setDepthApiModel
                      );
                    }
                  }}
                  disabled={
                    depthSource === "local"
                      ? depthOptions.length === 0
                      : depthApiModelGroups.length === 0
                  }
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
                  ) : depthApiModelGroups.length === 0 ? (
                    <option value="">No models available</option>
                  ) : (
                    depthApiModelGroups.map((group) => (
                      <optgroup key={group.provider} label={group.provider}>
                        {group.models.map((model) => (
                          <option
                            key={`${group.provider}:${model.id}`}
                            value={buildApiKey(group.provider, model.id)}
                            disabled={
                              !isModelAvailable(model) ||
                              !availableImageProviderOptions.includes(
                                group.provider
                              )
                            }
                          >
                            {getApiModelLabel(model)}
                          </option>
                        ))}
                      </optgroup>
                    ))
                  )}
                </Select>
              </Label>
              {depthSource === "api" &&
                !isDepthProviderAvailable &&
                depthProviderHint && <Hint>{depthProviderHint}</Hint>}
              <Label>
                Custom API model id
                <Input
                  placeholder="space:owner/name or endpoint:https://..."
                  value={depthApiModelOverride}
                  onChange={(e) => setDepthApiModelOverride(e.target.value)}
                  disabled={depthSource !== "api"}
                />
              </Label>
              <Label>
                Prompt
                <Textarea
                  rows={2}
                  value={depthPrompt}
                  onChange={(e) => setDepthPrompt(e.target.value)}
                />
              </Label>
              <Label>
                Size (WxH)
                <Input
                  placeholder="1024x1024"
                  value={depthSize}
                  onChange={(e) => setDepthSize(e.target.value)}
                />
              </Label>
              <ModelInputsEditor
                inputs={selectedDepthModel?.inputs}
                parametersRaw={depthParametersRaw}
                setParametersRaw={setDepthParametersRaw}
                disabled={depthSource === "api" && !depthProviderValue}
              />
              <Label>
                Parameters (JSON)
                <Textarea
                  rows={2}
                  value={depthParametersRaw}
                  onChange={(e) => setDepthParametersRaw(e.target.value)}
                  placeholder='{"prediction_mode": "absolute"}'
                />
              </Label>
              <Label className="ui-toggle">
                <Checkbox
                  checked={depthInvert}
                  onChange={(e) => {
                    setDepthInvert(e.target.checked);
                    setDepthInvertAuto(false);
                  }}
                  disabled={depthSource !== "local"}
                />
                Invert depth (Depth Anything)
              </Label>
              {depthSource === "local" && (
                <Hint>
                  Use when the model outputs inverse depth (near = larger).
                </Hint>
              )}
            </div>

            <div className="hudPipelineStage">
              <div className="hudPipelineHeader">
                <div>
                  <div className="hudPipelineTitle">Mesh</div>
                  <div className="hudPipelineMeta">
                    {reconSource === "local"
                      ? "Local reconstruction"
                      : "API model"}
                  </div>
                </div>
                <div
                  className="hudSourceToggle"
                  role="radiogroup"
                  aria-label="Mesh source"
                >
                  <button
                    type="button"
                    className="hudSourceButton"
                    data-active={reconSource === "local"}
                    aria-pressed={reconSource === "local"}
                    onClick={() => setReconSource("local")}
                  >
                    Local
                  </button>
                  <button
                    type="button"
                    className="hudSourceButton"
                    data-active={reconSource === "api"}
                    aria-pressed={reconSource === "api"}
                    onClick={() => setReconSource("api")}
                    disabled={availableReconProviderOptions.length === 0}
                  >
                    API
                  </button>
                </div>
              </div>
              <Label>
                Model
                <Select
                  value={
                    reconSource === "local" ? reconMethod : reconApiSelection
                  }
                  onChange={(e) => {
                    if (reconSource === "local") {
                      setReconMethod(e.target.value);
                    } else {
                      applyApiSelection(
                        e.target.value,
                        setReconProvider,
                        setReconApiModel
                      );
                    }
                  }}
                  disabled={
                    reconSource === "api" && reconApiModelGroups.length === 0
                  }
                >
                  {reconSource === "local" ? (
                    <>
                      <option value="poisson">Poisson</option>
                      <option value="alpha">Alpha Shape</option>
                    </>
                  ) : reconApiModelGroups.length === 0 ? (
                    <option value="">No models available</option>
                  ) : (
                    reconApiModelGroups.map((group) => (
                      <optgroup key={group.provider} label={group.provider}>
                        {group.models.map((model) => (
                          <option
                            key={`${group.provider}:${model.id}`}
                            value={buildApiKey(group.provider, model.id)}
                            disabled={
                              !isModelAvailable(model) ||
                              !availableReconProviderOptions.includes(
                                group.provider
                              )
                            }
                          >
                            {getApiModelLabel(model)}
                          </option>
                        ))}
                      </optgroup>
                    ))
                  )}
                </Select>
              </Label>
              {reconSource === "api" &&
                !isReconProviderAvailable &&
                reconProviderHint && <Hint>{reconProviderHint}</Hint>}
              <Label>
                Custom API model id
                <Input
                  placeholder="provider/model-id"
                  value={reconApiModelOverride}
                  onChange={(e) => setReconApiModelOverride(e.target.value)}
                  disabled={reconSource !== "api"}
                />
              </Label>
              <Label>
                Prompt
                <Textarea
                  rows={2}
                  value={reconPrompt}
                  onChange={(e) => setReconPrompt(e.target.value)}
                  disabled={reconSource !== "api"}
                />
              </Label>
              <Label>
                Format
                <Input
                  placeholder="obj"
                  value={reconFormat}
                  onChange={(e) => setReconFormat(e.target.value)}
                  disabled={reconSource !== "api"}
                />
              </Label>
              <ModelInputsEditor
                inputs={selectedReconModel?.inputs}
                parametersRaw={reconParametersRaw}
                setParametersRaw={setReconParametersRaw}
                disabled={reconSource !== "api" || !reconProviderValue}
              />
              <Label>
                Parameters (JSON)
                <Textarea
                  rows={2}
                  value={reconParametersRaw}
                  onChange={(e) => setReconParametersRaw(e.target.value)}
                  placeholder='{"should_remesh": true}'
                  disabled={reconSource !== "api"}
                />
              </Label>
            </div>
          </div>
          {modelsError && <Hint>Model list error: {modelsError}</Hint>}
          {modelsLoaded &&
            !modelsError &&
            cutoutOptions.length === 0 &&
            depthOptions.length === 0 && (
              <Hint>
                No local pipeline models available from ai-kit catalog.
              </Hint>
            )}
          {modelsLoaded &&
            !modelsError &&
            availableImageProviderOptions.length === 0 && (
              <Hint>No API image models available from ai-kit providers.</Hint>
            )}
        </Group>

        <Group>
          <GroupTitle>Output</GroupTitle>
          <Label className="ui-toggle">
            <Checkbox
              checked={pointsEnabled}
              onChange={(e) => setPointsEnabled(e.target.checked)}
            />
            Export point cloud (PLY)
          </Label>
          <Hint>Generates `points.ply` for hologram/point renders.</Hint>
          <div className="hudControlRow">
            <Button
              onClick={rebuildRecon}
              disabled={!canRebuild || rebuildRunning}
              title={
                canRebuild
                  ? undefined
                  : "Load a completed local job to rebuild the mesh."
              }
            >
              {rebuildRunning ? "Rebuilding..." : "Rebuild mesh"}
            </Button>
          </div>
          {rebuildRunning && (
            <div className="hudRebuildProgress" aria-live="polite">
              <div className="hudRebuildProgressLabel">
                <span>Rebuild mesh</span>
                <span className="hudRebuildProgressValue">
                  {Math.round(rebuildProgress * 100)}%
                </span>
              </div>
              <div
                className="hudRebuildProgressTrack"
                style={
                  { "--progress": rebuildProgress } as React.CSSProperties
                }
              >
                <div className="hudRebuildProgressFill" />
              </div>
            </div>
          )}
          <Hint>
            Rebuilds mesh from existing views + depth (local mode only).
          </Hint>
          {rebuildError && <pre className="ui-error">{rebuildError}</pre>}
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
              onChange={(e) =>
                applyApiSelection(
                  e.target.value,
                  setCaptionProvider,
                  setCaptionModel
                )
              }
              disabled={!captionEnabled || availableVisionModels.length === 0}
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
                        disabled={
                          !isModelAvailable(model) ||
                          !availableVisionProviderOptions.includes(
                            group.provider
                          )
                        }
                      >
                        {getApiModelLabel(model)}
                      </option>
                    ))}
                  </optgroup>
                ))
              )}
            </Select>
          </Label>
          {captionEnabled &&
            !isCaptionProviderAvailable &&
            captionProviderHint && <Hint>{captionProviderHint}</Hint>}
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
          {!modelsError && availableVisionProviderOptions.length === 0 && (
            <Hint>No vision-capable models available from ai-kit.</Hint>
          )}
        </Group>

        <div className="hudActions">
          <Button
            disabled={
              !modelFile ||
              Boolean(apiSelectionError) ||
              !modelsLoaded ||
              Boolean(modelsError)
            }
            onClick={startBake}
            title={
              apiSelectionError ||
              modelsError ||
              (!modelsLoaded ? "Model list still loading." : undefined)
            }
          >
            Start bake
          </Button>
          <Badge className="hudBadge">
            API {client.getResultUrl("<job>").split("/v1/")[0]}
          </Badge>
        </div>
        {apiSelectionError && <Hint>{apiSelectionError}</Hint>}

        <div
          className="hudProgressContainer"
          data-status={status}
          style={
            {
              "--hud-progress-stage-count": PIPELINE_STAGES.length,
              "--hud-progress-stage-count-minus-one": Math.max(
                PIPELINE_STAGES.length - 1,
                0
              ),
            } as React.CSSProperties
          }
        >
          <div className="hudProgressHeader">
            <span className="hudProgressStatus" data-status={status}>
              {status === "idle" && "Ready to forge"}
              {status === "uploading" && "Uploading image..."}
              {status === "queued" && "Queued for processing..."}
              {status === "loading" && "Loading job..."}
              {status === "running" &&
                (eventLog[0]?.stage
                  ? `${eventLog[0].stage.replace(/_/g, " ")}...`
                  : "Processing...")}
              {status === "done" && "Complete"}
              {status === "error" && "Error occurred"}
            </span>
            <span className="hudProgressPercent">
              {(progress * 100).toFixed(0)}%
            </span>
          </div>

          <div className="hudProgressBarOuter">
            <div
              className="hudProgressBarInner"
              style={{ "--progress": progress } as React.CSSProperties}
              data-status={status}
            />
            <div
              className="hudProgressBarGlow"
              style={{ "--progress": progress } as React.CSSProperties}
            />
            <div className="hudProgressBarScanlines" />
          </div>

          <div className="hudProgressStages">
            {PIPELINE_STAGES.map((stage, idx) => {
              const stageData = stageProgressItems.find(
                (s) => s.stage === stage
              );
              const isActive = eventLog[0]?.stage === stage;
              const isComplete = (stageData?.progress ?? 0) >= 1;
              const hasStarted = stageData !== undefined;
              return (
                <div
                  key={stage}
                  className="hudProgressStage"
                  data-active={isActive}
                  data-complete={isComplete}
                  data-started={hasStarted}
                >
                  <div className="hudProgressStageDot">
                    {isComplete ? (
                      <svg viewBox="0 0 16 16" fill="currentColor">
                        <path d="M13.78 4.22a.75.75 0 010 1.06l-7.25 7.25a.75.75 0 01-1.06 0L2.22 9.28a.75.75 0 011.06-1.06L6 10.94l6.72-6.72a.75.75 0 011.06 0z" />
                      </svg>
                    ) : (
                      <span>{idx + 1}</span>
                    )}
                  </div>
                  <span className="hudProgressStageLabel">
                    {stage.replace(/_/g, " ")}
                  </span>
                </div>
              );
            })}
          </div>

          {jobId && (
            <div className="hudProgressJobId">
              <span>Job:</span>
              <code>{jobId.slice(0, 12)}...</code>
            </div>
          )}

          {error && <pre className="ui-error">{error}</pre>}
          {apiSelectionError && (
            <div className="ui-warning">{apiSelectionError}</div>
          )}
        </div>
      </Panel>

      <Panel className="hudPanel">
        <PanelTitle>Viewer</PanelTitle>
        <Status>
          {canvasLocation === "stage"
            ? "Full-screen preview is active in the stage."
            : "Preview is docked in the lounge modal."}
        </Status>
        <Label>
          Render mode
          <Select
            value={renderMode}
            onChange={(e) => setRenderMode(e.target.value as RenderMode)}
          >
            <option value="mesh">Mesh</option>
            <option value="points">Points</option>
            <option value="hologram">Hologram</option>
          </Select>
        </Label>
        {renderMode === "points" && !pointsUrl && (
          <Hint>Point cloud not ready yet; using mesh points.</Hint>
        )}
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
