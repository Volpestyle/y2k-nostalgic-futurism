import React, { useEffect, useMemo, useRef, useState } from "react";
import { createHoloClient, type ModelMetadata } from "@holo/sdk";
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

export function App() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const viewerRef = useRef<BasicGltfViewer | null>(null);

  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [file, setFile] = useState<File | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [status, setStatus] = useState<string>("idle");
  const [progress, setProgress] = useState<number>(0);
  const [error, setError] = useState<string | null>(null);
  const [models, setModels] = useState<ModelMetadata[]>([]);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [modelsLoaded, setModelsLoaded] = useState(false);

  const [cutoutModel, setCutoutModel] = useState("rmbg-1.4");
  const [depthModel, setDepthModel] = useState("depth-anything-v2-small");
  const [viewsModel, setViewsModel] = useState("zero123-plus");
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
  const providerModels = useMemo(() => {
    return visionModels.filter((model) => model.provider === captionProvider);
  }, [visionModels, captionProvider]);
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
    if (!providerModels.length) return;
    if (!providerModels.some((model) => model.id === captionModel)) {
      setCaptionModel(providerModels[0].id);
    }
  }, [providerModels, captionModel]);

  async function startBake() {
    setError(null);
    if (!file) return;

    const viewsConfig: Record<string, unknown> = { count: viewsCount };
    if (viewsModelValue) {
      viewsConfig.model = viewsModelValue;
    }

    const bakeSpec = BakeSpecSchema.parse({
      version: "0.1.0",
      cutout: { model: cutoutModel },
      depth: { model: depthModel },
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
                <GroupTitle>Pipeline models</GroupTitle>
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
                {modelsError && <Hint>Catalog model list error: {modelsError}</Hint>}
                {modelsLoaded &&
                  !modelsError &&
                  cutoutOptions.length === 0 &&
                  depthOptions.length === 0 && (
                  <Hint>No pipeline models available from inference-kit.</Hint>
                )}
              </Group>

              <Group>
                <GroupTitle>AI caption (inference-kit)</GroupTitle>
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
                  <Hint>No vision-capable models available from inference-kit.</Hint>
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
