import { z } from "zod";

export const BakeSpecVersion = z.literal("0.1.0");

export const BakeSpecSchema = z.object({
  version: BakeSpecVersion,
  cutout: z
    .object({
      model: z.string().default("rmbg-1.4"),
      refine: z.enum(["none", "sam"]).default("none"),
      featherPx: z.number().int().min(0).max(20).default(3),
    })
    .default({}),
  views: z
    .object({
      // For "Mode B" baking.
      count: z.number().int().min(1).max(64).default(12),
      elevDeg: z.number().min(-60).max(60).default(10),
      fovDeg: z.number().min(15).max(90).default(35),
      seed: z.number().int().min(0).max(2 ** 31 - 1).default(42),
      provider: z.string().optional(),
      model: z.string().optional(),
      prompt: z.string().optional(),
      size: z.string().optional(),
      resolution: z.number().int().min(256).max(1536).default(512),
    })
    .default({}),
  depth: z
    .object({
      model: z.string().default("depth-anything-v2-small"),
      resolution: z.number().int().min(256).max(1536).default(512),
    })
    .default({}),
  recon: z
    .object({
      method: z.enum(["poisson", "alpha"/*, "gsplat"*/]).default("poisson"),
      voxelSize: z.number().min(0).default(0.006),
    })
    .default({}),
  mesh: z
    .object({
      targetTris: z.number().int().min(100).max(50000).default(2000),
      thickness: z.number().min(0).default(0.02),
    })
    .default({}),
  export: z
    .object({
      format: z.enum(["gltf", "glb"]).default("gltf"),
      optimize: z.enum(["none", "gltfpack"]).default("none"),
    })
    .default({}),
  ai: z
    .object({
      caption: z
        .object({
          enabled: z.boolean().default(false),
          provider: z.string().default("openai"),
          model: z.string().default("gpt-4o-mini"),
          prompt: z
            .string()
            .default(
              "Describe the subject and materials in this image for 3D reconstruction. Keep it brief."
            ),
          temperature: z.number().min(0).max(2).default(0.2),
          maxTokens: z.number().int().min(16).max(512).default(200),
        })
        .default({}),
    })
    .default({}),
});

export type BakeSpec = z.infer<typeof BakeSpecSchema>;

export function parseBakeSpec(input: unknown): BakeSpec {
  return BakeSpecSchema.parse(input);
}

export function canonicalizeBakeSpec(input: unknown): string {
  const spec = parseBakeSpec(input);
  return JSON.stringify(spec);
}
