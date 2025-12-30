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
};

export interface HoloClient {
  createJob(args: { image: File | Blob; bakeSpec?: BakeSpec | unknown }): Promise<CreateJobResponse>;
  getJob(jobId: string): Promise<JobStatusResponse>;
  getResultUrl(jobId: string): string;
  listJobs(args?: { status?: JobStatusResponse["status"]; limit?: number }): Promise<JobStatusResponse[]>;
  listProviderModels(args?: { providers?: string[]; refresh?: boolean }): Promise<ModelMetadata[]>;
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

const DEFAULT_MODELS: ModelMetadata[] = [
  {
    id: "bria/remove-background",
    displayName: "Bria Remove Background",
    provider: "catalog",
    family: "cutout",
    capabilities: {
      text: false,
      vision: true,
      image: true,
      tool_use: false,
      structured_output: false,
      reasoning: false
    }
  },
  {
    id: "jd7h/zero123plusplus",
    displayName: "Zero123++",
    provider: "catalog",
    family: "views",
    capabilities: {
      text: false,
      vision: true,
      image: true,
      tool_use: false,
      structured_output: false,
      reasoning: false
    }
  },
  {
    id: "chenxwh/depth-anything-v2",
    displayName: "Depth Anything v2",
    provider: "catalog",
    family: "depth",
    capabilities: {
      text: false,
      vision: true,
      image: true,
      tool_use: false,
      structured_output: false,
      reasoning: false
    }
  },
  {
    id: "bria/remove-background",
    displayName: "Bria Remove Background",
    provider: "replicate",
    family: "cutout",
    capabilities: {
      text: false,
      vision: true,
      image: true,
      tool_use: false,
      structured_output: false,
      reasoning: false
    }
  },
  {
    id: "jd7h/zero123plusplus",
    displayName: "Zero123++",
    provider: "replicate",
    family: "views",
    capabilities: {
      text: false,
      vision: true,
      image: true,
      tool_use: false,
      structured_output: false,
      reasoning: false
    }
  },
  {
    id: "chenxwh/depth-anything-v2",
    displayName: "Depth Anything v2",
    provider: "replicate",
    family: "depth",
    capabilities: {
      text: false,
      vision: true,
      image: true,
      tool_use: false,
      structured_output: false,
      reasoning: false
    }
  },
  {
    id: "multi-image-to-3d",
    displayName: "Meshy Multi-Image to 3D",
    provider: "meshy",
    family: "recon",
    capabilities: {
      text: false,
      vision: true,
      image: true,
      tool_use: false,
      structured_output: false,
      reasoning: false
    }
  },
  {
    id: "gpt-4o-mini",
    displayName: "GPT-4o Mini",
    provider: "openai",
    capabilities: {
      text: true,
      vision: true,
      image: false,
      tool_use: true,
      structured_output: true,
      reasoning: true
    }
  }
];

export function createHoloClient(baseUrl: string): HoloClient {
  const root = baseUrl.replace(/\/$/, "");

  return {
    async createJob({ image, bakeSpec }) {
      const form = new FormData();
      form.append("file", image);
      if (bakeSpec) {
        form.append("bakeSpec", JSON.stringify(bakeSpec));
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
    },

    async listProviderModels(args) {
      if (!args?.providers?.length) return DEFAULT_MODELS;
      return DEFAULT_MODELS.filter((model) => args.providers?.includes(model.provider));
    },

  };
}
