import type { BakeSpec } from "@holo/shared-spec";

export type CreateJobResponse = { jobId: string };

export type JobStatusResponse = {
  id: string;
  status: "queued" | "running" | "done" | "error";
  progress: number;
  createdAt?: string;
  updatedAt?: string;
  inputKey: string;
  outputKey?: string;
  error?: string;
  specJson: string;
  resultUrl?: string;
  stage?: string;
  output?: {
    glb?: { url?: string; key?: string; bucket?: string };
    manifest?: { url?: string; key?: string; bucket?: string };
  };
};

export type ModelInputSpec = {
  name: string;
  type: "string" | "number" | "boolean" | "select";
  label?: string;
  description?: string;
  default?: string | number | boolean;
  min?: number;
  max?: number;
  step?: number;
  options?: { label: string; value: string }[];
  placeholder?: string;
  multiline?: boolean;
};

export type ModelCapabilities = {
  text: boolean;
  vision: boolean;
  image?: boolean;
  tool_use: boolean;
  structured_output: boolean;
  reasoning: boolean;
};

export type ModelMetadata = {
  id: string;
  displayName: string;
  provider: string;
  family?: string;
  capabilities: ModelCapabilities;
  contextWindow?: number;
  tokenPrices?: { input: number; output: number };
  deprecated?: boolean;
  inPreview?: boolean;
  available?: boolean;
  inputs?: ModelInputSpec[];
};

export interface HoloClient {
  createJob(args: {
    image: File | Blob;
    bakeSpec?: BakeSpec | unknown;
    pipelineConfig?: Record<string, unknown>;
  }): Promise<CreateJobResponse>;
  getJob(jobId: string): Promise<JobStatusResponse>;
  getResultUrl(jobId: string): string;
  listJobs(args?: { status?: JobStatusResponse["status"]; limit?: number }): Promise<JobStatusResponse[]>;
  listProviderModels(args?: {
    providers?: string[];
    refresh?: boolean;
    allowFallback?: boolean;
  }): Promise<ModelMetadata[]>;
}

type ApiJobStatus = {
  job_id: string;
  state?: string;
  stage?: string;
  progress?: number;
  created_at_ms?: number;
  updated_at_ms?: number;
  error?: string;
  input?: { bucket?: string; key?: string };
  output?: {
    glb?: { bucket?: string; key?: string; url?: string };
    manifest?: { bucket?: string; key?: string; url?: string };
  };
};

const RECENT_JOBS_KEY = "holo.recentJobs";

const loadStoredJobs = (): JobStatusResponse[] => {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(RECENT_JOBS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(Boolean) as JobStatusResponse[];
  } catch {
    return [];
  }
};

const saveStoredJobs = (jobs: JobStatusResponse[]) => {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(RECENT_JOBS_KEY, JSON.stringify(jobs));
  } catch {
    // ignore storage errors
  }
};

const rememberJob = (job: JobStatusResponse) => {
  const existing = loadStoredJobs();
  const next = existing.filter((item) => item.id !== job.id);
  next.unshift(job);
  saveStoredJobs(next.slice(0, 50));
};

const mapStateToStatus = (state: string | undefined): JobStatusResponse["status"] => {
  switch ((state || "").toUpperCase()) {
    case "QUEUED":
      return "queued";
    case "RUNNING":
      return "running";
    case "SUCCEEDED":
      return "done";
    case "FAILED":
    case "CANCELED":
    case "CANCELLED":
      return "error";
    default:
      return "running";
  }
};

const toIso = (ms?: number): string | undefined => {
  if (!ms || !Number.isFinite(ms)) return undefined;
  return new Date(ms).toISOString();
};

const normalizeJobStatus = (data: any): JobStatusResponse => {
  if (data && data.id && data.status) {
    return data as JobStatusResponse;
  }
  const api = data as ApiJobStatus;
  const id = api.job_id || (data?.id as string) || "";
  if (!id) {
    throw new Error("Invalid job response");
  }
  const status = mapStateToStatus(api.state);
  const progress = typeof api.progress === "number" ? api.progress : 0;
  const createdAt = toIso(api.created_at_ms);
  const updatedAt = toIso(api.updated_at_ms);
  const resultUrl = api.output?.glb?.url;
  return {
    id,
    status,
    progress,
    createdAt,
    updatedAt,
    error: api.error,
    inputKey: api.input?.key || "",
    outputKey: api.output?.glb?.key,
    specJson: "",
    resultUrl,
    stage: api.stage,
    output: api.output
  };
};

export function createHoloClient(baseUrl: string): HoloClient {
  const root = baseUrl.replace(/\/$/, "");

  return {
    async createJob({ image, bakeSpec, pipelineConfig }) {
      const form = new FormData();
      form.append("file", image);
      if (bakeSpec) {
        form.append("bakeSpec", JSON.stringify(bakeSpec));
      }
      if (pipelineConfig) {
        form.append("pipelineConfig", JSON.stringify(pipelineConfig));
      }
      const res = await fetch(`${root}/v1/jobs`, { method: "POST", body: form });
      if (!res.ok) throw new Error(`createJob failed: ${res.status} ${await res.text()}`);
      const data = (await res.json()) as { jobId?: string; job_id?: string };
      const jobId = data.jobId || data.job_id;
      if (!jobId) {
        throw new Error("createJob failed: missing job id");
      }
      const createdAt = new Date().toISOString();
      rememberJob({
        id: jobId,
        status: "queued",
        progress: 0,
        createdAt,
        updatedAt: createdAt,
        inputKey: "",
        specJson: ""
      });
      return { jobId };
    },

    async getJob(jobId) {
      const res = await fetch(`${root}/v1/jobs/${jobId}`);
      if (!res.ok) throw new Error(`getJob failed: ${res.status} ${await res.text()}`);
      const raw = await res.json();
      const job = normalizeJobStatus(raw);
      rememberJob(job);
      return job;
    },

    getResultUrl(jobId) {
      return `${root}/v1/jobs/${jobId}/result`;
    },

    async listJobs(args) {
      const params = new URLSearchParams();
      if (args?.status) {
        params.set("status", args.status);
      }
      if (args?.limit) {
        params.set("limit", String(args.limit));
      }
      const query = params.toString();
      const url = `${root}/v1/jobs${query ? `?${query}` : ""}`;
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`listJobs failed: ${res.status} ${await res.text()}`);
        const raw = (await res.json()) as any;
        if (!Array.isArray(raw)) {
          throw new Error("listJobs failed: invalid response");
        }
        const jobs = raw.map(normalizeJobStatus);
        jobs.forEach(rememberJob);
        return jobs;
      } catch {
        const stored = loadStoredJobs();
        const filtered = args?.status
          ? stored.filter((job) => job.status === args.status)
          : stored;
        const sorted = [...filtered].sort((a, b) => {
          const aTime = a.updatedAt ? Date.parse(a.updatedAt) : 0;
          const bTime = b.updatedAt ? Date.parse(b.updatedAt) : 0;
          return bTime - aTime;
        });
        return sorted.slice(0, args?.limit || 25);
      }
    },

    async listProviderModels(args) {
      const params = new URLSearchParams();
      if (args?.providers?.length) {
        params.set("providers", args.providers.join(","));
      }
      if (args?.refresh) {
        params.set("refresh", "true");
      }
      const query = params.toString();
      const url = `${root}/v1/ai/provider-models${query ? `?${query}` : ""}`;
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`listProviderModels failed: ${res.status} ${await res.text()}`);
        return (await res.json()) as ModelMetadata[];
      } catch (error) {
        throw error;
      }
    },

  };
}
