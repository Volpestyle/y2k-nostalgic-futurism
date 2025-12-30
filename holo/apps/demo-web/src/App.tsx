import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createHoloClient, type JobStatusResponse, type ModelMetadata } from "@holo/sdk";
import { BasicGltfViewer } from "@holo/viewer-three";
import { BakeSpecSchema } from "@holo/shared-spec";
import {
  AppShell,
  Badge,
  Button,
  Checkbox,
  FieldRow,
  Group,
  GroupTitle,
  Grid,
  Hint,
  Input,
  Label,
  Panel,
  PanelTitle,
  Select,
  Status,
  Textarea,
  Window,
  WindowBody,
  WindowHeader,
  WindowSubtitle,
  WindowTitle
} from "@holo/ui-kit";
import { VisualizerPanel } from "./VisualizerPanel";

const client = createHoloClient(import.meta.env.VITE_API_BASE_URL || "http://localhost:8080");
const defaultCaptionPrompt =
  "Describe the subject and materials in this image for 3D reconstruction. Keep it brief.";
type PipelineSource = "local" | "api";

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

const filterModelsByFamily = (models: ModelMetadata[], family: string) => {
  const familyTagged = models.filter((model) => model.family);
  if (familyTagged.length === 0) {
    return models;
  }
  return models.filter((model) => model.family === family);
};

export function App() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const viewerRef = useRef<BasicGltfViewer | null>(null);

  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [file, setFile] = useState<File | null>(null);
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

  const [cutoutSource, setCutoutSource] = useState<PipelineSource>("local");
  const [cutoutModel, setCutoutModel] = useState("rmbg-1.4");
  const [cutoutProvider, setCutoutProvider] = useState("huggingface");
  const [cutoutApiModel, setCutoutApiModel] = useState("");
  const [depthSource, setDepthSource] = useState<PipelineSource>("local");
  const [depthModel, setDepthModel] = useState("depth-anything-v2-small");
  const [depthProvider, setDepthProvider] = useState("huggingface");
  const [depthApiModel, setDepthApiModel] = useState("");
  const [viewsSource, setViewsSource] = useState<PipelineSource>("local");
  const [viewsModel, setViewsModel] = useState("stable-zero123");
  const [viewsProvider, setViewsProvider] = useState("huggingface");
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
    document.body.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    if (!jobId) return;
    setJobIdInput(jobId);
  }, [jobId]);

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
    return filterModelsByFamily(
      visionModels.filter((model) => model.provider === cutoutProvider),
      "cutout"
    );
  }, [visionModels, cutoutProvider]);
  const depthProviderModels = useMemo(() => {
    return filterModelsByFamily(
      visionModels.filter((model) => model.provider === depthProvider),
      "depth"
    );
  }, [visionModels, depthProvider]);
  const viewsProviderModels = useMemo(() => {
    return filterModelsByFamily(
      visionModels.filter((model) => model.provider === viewsProvider),
      "views"
    );
  }, [visionModels, viewsProvider]);
  const providerModels = useMemo(() => {
    return visionModels.filter((model) => model.provider === captionProvider);
  }, [visionModels, captionProvider]);
  const cutoutProviderValue = providerOptions.length > 0 ? cutoutProvider : "";
  const cutoutApiModelValue = cutoutProviderModels.length > 0 ? cutoutApiModel : "";
  const depthProviderValue = providerOptions.length > 0 ? depthProvider : "";
  const depthApiModelValue = depthProviderModels.length > 0 ? depthApiModel : "";
  const viewsProviderValue = providerOptions.length > 0 ? viewsProvider : "";
  const viewsApiModelValue = viewsProviderModels.length > 0 ? viewsApiModel : "";
  const captionProviderValue = providerOptions.length > 0 ? captionProvider : "";
  const captionModelValue = providerModels.length > 0 ? captionModel : "";
  const viewsModelValue = viewsOptions.length > 0 ? viewsModel : "";

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
        if (j.status === "done") {
          const url = j.resultUrl || client.getResultUrl(jobId);
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
  }, [jobId]);

  return (
    <AppShell>
      <Window>
        <WindowHeader>
          <div>
            <WindowTitle>holo-2d3d demo</WindowTitle>
            <WindowSubtitle>Upload - async bake - view result</WindowSubtitle>
          </div>
          <div className="appHeaderControls">
            <Badge className="ui-badge-invert">
              API: {client.getResultUrl("<job>").replace("/v1/jobs/<job>/result", "")}
            </Badge>
            <Label className="ui-toggle appThemeToggle">
              <Checkbox
                checked={theme === "dark"}
                onChange={(event) => setTheme(event.target.checked ? "dark" : "light")}
              />
              Dark mode
            </Label>
          </div>
        </WindowHeader>

        <WindowBody>
          <Grid>
            <Panel>
              <PanelTitle>1) Input</PanelTitle>
              <Label>
                Image file
                <Input
                  type="file"
                  accept="image/*"
                  onChange={(e) => setFile(e.target.files?.[0] || null)}
                />
              </Label>

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
                      {recentJobs.length === 0 ? "No completed jobs yet" : "Select a job"}
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
                <FieldRow>
                  <Button onClick={loadJob} disabled={!jobIdInput.trim()}>
                    Load job
                  </Button>
                  <Button onClick={loadRecentJobs} disabled={jobsLoading} variant="ghost">
                    {jobsLoading ? "Refreshing..." : "Refresh list"}
                  </Button>
                </FieldRow>
                <Hint>Load a previous job to restore its artifacts and preview.</Hint>
                {jobsError && <Hint>Job list error: {jobsError}</Hint>}
              </Group>

              <Group>
                <GroupTitle>Pipeline models</GroupTitle>
                <Label>
                  Cutout source
                  <Select value={cutoutSource} onChange={(e) => setCutoutSource(e.target.value as PipelineSource)}>
                    <option value="local">Local</option>
                    <option value="api" disabled={providerOptions.length === 0}>
                      API
                    </option>
                  </Select>
                </Label>
                {cutoutSource === "local" ? (
                  <Label>
                    Cutout model
                    <Select
                      value={cutoutOptions.length > 0 ? cutoutModel : ""}
                      onChange={(e) => setCutoutModel(e.target.value)}
                      disabled={cutoutOptions.length === 0}
                    >
                      {cutoutOptions.length === 0 ? (
                        <option value="">No cutout models available</option>
                      ) : (
                        cutoutOptions.map((model) => (
                          <option key={model.id} value={model.id}>
                            {model.displayName || model.id}
                          </option>
                        ))
                      )}
                    </Select>
                  </Label>
                ) : (
                  <FieldRow>
                    <Label>
                      Cutout provider
                      <Select
                        value={cutoutProviderValue}
                        onChange={(e) => setCutoutProvider(e.target.value)}
                        disabled={providerOptions.length === 0}
                      >
                        {providerOptions.length === 0 ? (
                          <option value="">No providers available</option>
                        ) : (
                          providerOptions.map((provider) => (
                            <option key={provider} value={provider}>
                              {provider}
                            </option>
                          ))
                        )}
                      </Select>
                    </Label>
                    <Label>
                      Cutout model
                      <Select
                        value={cutoutApiModelValue}
                        onChange={(e) => setCutoutApiModel(e.target.value)}
                        disabled={cutoutProviderModels.length === 0}
                      >
                        {cutoutProviderModels.length === 0 ? (
                          <option value="">No models available</option>
                        ) : (
                          cutoutProviderModels.map((model) => (
                            <option key={model.id} value={model.id}>
                              {model.displayName || model.id}
                            </option>
                          ))
                        )}
                      </Select>
                    </Label>
                  </FieldRow>
                )}
                <Label>
                  Depth source
                  <Select value={depthSource} onChange={(e) => setDepthSource(e.target.value as PipelineSource)}>
                    <option value="local">Local</option>
                    <option value="api" disabled={providerOptions.length === 0}>
                      API
                    </option>
                  </Select>
                </Label>
                {depthSource === "local" ? (
                  <Label>
                    Depth model
                    <Select
                      value={depthOptions.length > 0 ? depthModel : ""}
                      onChange={(e) => setDepthModel(e.target.value)}
                      disabled={depthOptions.length === 0}
                    >
                      {depthOptions.length === 0 ? (
                        <option value="">No depth models available</option>
                      ) : (
                        depthOptions.map((model) => (
                          <option key={model.id} value={model.id}>
                            {model.displayName || model.id}
                          </option>
                        ))
                      )}
                    </Select>
                  </Label>
                ) : (
                  <FieldRow>
                    <Label>
                      Depth provider
                      <Select
                        value={depthProviderValue}
                        onChange={(e) => setDepthProvider(e.target.value)}
                        disabled={providerOptions.length === 0}
                      >
                        {providerOptions.length === 0 ? (
                          <option value="">No providers available</option>
                        ) : (
                          providerOptions.map((provider) => (
                            <option key={provider} value={provider}>
                              {provider}
                            </option>
                          ))
                        )}
                      </Select>
                    </Label>
                    <Label>
                      Depth model
                      <Select
                        value={depthApiModelValue}
                        onChange={(e) => setDepthApiModel(e.target.value)}
                        disabled={depthProviderModels.length === 0}
                      >
                        {depthProviderModels.length === 0 ? (
                          <option value="">No models available</option>
                        ) : (
                          depthProviderModels.map((model) => (
                            <option key={model.id} value={model.id}>
                              {model.displayName || model.id}
                            </option>
                          ))
                        )}
                      </Select>
                    </Label>
                  </FieldRow>
                )}
                <Label>
                  View source
                  <Select value={viewsSource} onChange={(e) => setViewsSource(e.target.value as PipelineSource)}>
                    <option value="local">Local</option>
                    <option value="api" disabled={providerOptions.length === 0}>
                      API
                    </option>
                  </Select>
                </Label>
                {viewsSource === "local" ? (
                  <Label>
                    View model
                    <Select
                      value={viewsModelValue}
                      onChange={(e) => setViewsModel(e.target.value)}
                      disabled={viewsOptions.length === 0}
                    >
                      {viewsOptions.length === 0 ? (
                        <option value="">No view models available</option>
                      ) : (
                        viewsOptions.map((model) => (
                          <option key={model.id} value={model.id}>
                            {model.displayName || model.id}
                          </option>
                        ))
                      )}
                    </Select>
                  </Label>
                ) : (
                  <FieldRow>
                    <Label>
                      View provider
                      <Select
                        value={viewsProviderValue}
                        onChange={(e) => setViewsProvider(e.target.value)}
                        disabled={providerOptions.length === 0}
                      >
                        {providerOptions.length === 0 ? (
                          <option value="">No providers available</option>
                        ) : (
                          providerOptions.map((provider) => (
                            <option key={provider} value={provider}>
                              {provider}
                            </option>
                          ))
                        )}
                      </Select>
                    </Label>
                    <Label>
                      View model
                      <Select
                        value={viewsApiModelValue}
                        onChange={(e) => setViewsApiModel(e.target.value)}
                        disabled={viewsProviderModels.length === 0}
                      >
                        {viewsProviderModels.length === 0 ? (
                          <option value="">No models available</option>
                        ) : (
                          viewsProviderModels.map((model) => (
                            <option key={model.id} value={model.id}>
                              {model.displayName || model.id}
                            </option>
                          ))
                        )}
                      </Select>
                    </Label>
                  </FieldRow>
                )}
                <Label>
                  View count: {viewsCount}
                  <Input
                    type="range"
                    min={4}
                    max={12}
                    step={1}
                    value={viewsCount}
                    onChange={(e) => setViewsCount(Number(e.target.value))}
                  />
                </Label>
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
                <GroupTitle>AI caption (ai-kit)</GroupTitle>
                <Label className="ui-toggle">
                  <Checkbox
                    checked={captionEnabled}
                    onChange={(e) => setCaptionEnabled(e.target.checked)}
                  />
                  Enable captioning
                </Label>
                <FieldRow>
                  <Label>
                    Provider
                    <Select
                      value={captionProviderValue}
                      onChange={(e) => setCaptionProvider(e.target.value)}
                      disabled={!captionEnabled || providerOptions.length === 0}
                    >
                      {providerOptions.length === 0 ? (
                        <option value="">No providers available</option>
                      ) : (
                        providerOptions.map((provider) => (
                          <option key={provider} value={provider}>
                            {provider}
                          </option>
                        ))
                      )}
                    </Select>
                  </Label>
                  <Label>
                    Model
                    <Select
                      value={captionModelValue}
                      onChange={(e) => setCaptionModel(e.target.value)}
                      disabled={!captionEnabled || providerModels.length === 0}
                    >
                      {providerModels.length === 0 ? (
                        <option value="">No models available</option>
                      ) : (
                        providerModels.map((model) => (
                          <option key={model.id} value={model.id}>
                            {model.displayName || model.id}
                          </option>
                        ))
                      )}
                    </Select>
                  </Label>
                </FieldRow>
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
              <Button disabled={!file} onClick={startBake}>
                Start bake
              </Button>

              <Status>
                <div><strong>Status:</strong> {status}</div>
                <div><strong>Progress:</strong> {(progress * 100).toFixed(0)}%</div>
                {jobId && <div><strong>Job:</strong> {jobId}</div>}
                {error && <pre className="ui-error">{error}</pre>}
              </Status>
            </Panel>

            <Panel>
              <PanelTitle>2) Viewer</PanelTitle>
              <div className="ui-canvas-frame">
                <canvas ref={canvasRef} className="ui-canvas" />
              </div>
              <Hint>
                This scaffold renders a placeholder glTF triangle once the worker marks the job complete.
              </Hint>
            </Panel>
          </Grid>

          <VisualizerPanel />
        </WindowBody>
      </Window>
    </AppShell>
  );
}
