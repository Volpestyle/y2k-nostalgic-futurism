import type { BakeSpec } from "@holo/shared-spec";

export type CreateJobResponse = { jobId: string };

export type JobStatusResponse = {
  id: string;
  status: "queued" | "running" | "done" | "error";
  progress: number;
  inputKey: string;
  outputKey?: string;
  error?: string;
  specJson: string;
  resultUrl?: string;
};

export type ModelCapabilities = {
  text: boolean;
  vision: boolean;
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
};

export interface HoloClient {
  createJob(args: { image: File | Blob; bakeSpec?: BakeSpec | unknown }): Promise<CreateJobResponse>;
  getJob(jobId: string): Promise<JobStatusResponse>;
  getResultUrl(jobId: string): string;
  listProviderModels(args?: { providers?: string[]; refresh?: boolean }): Promise<ModelMetadata[]>;
}

export function createHoloClient(baseUrl: string): HoloClient {
  const root = baseUrl.replace(/\/$/, "");

  return {
    async createJob({ image, bakeSpec }) {
      const form = new FormData();
      form.append("image", image);
      if (bakeSpec) {
        form.append("bakeSpec", JSON.stringify(bakeSpec));
      }
      const res = await fetch(`${root}/v1/jobs`, { method: "POST", body: form });
      if (!res.ok) throw new Error(`createJob failed: ${res.status} ${await res.text()}`);
      return (await res.json()) as CreateJobResponse;
    },

    async getJob(jobId) {
      const res = await fetch(`${root}/v1/jobs/${jobId}`);
      if (!res.ok) throw new Error(`getJob failed: ${res.status} ${await res.text()}`);
      return (await res.json()) as JobStatusResponse;
    },

    getResultUrl(jobId) {
      return `${root}/v1/jobs/${jobId}/result`;
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
      const res = await fetch(url);
      if (!res.ok) throw new Error(`listProviderModels failed: ${res.status} ${await res.text()}`);
      return (await res.json()) as ModelMetadata[];
    },

  };
}
