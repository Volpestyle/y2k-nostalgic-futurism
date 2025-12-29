import { z } from "zod";

export const BakeSpecV0_1 = z.object({
  version: z.literal("0.1.0"),

  cutout: z
    .object({
      model: z.string().default("rmbg-1.4"),
      refine: z.enum(["none", "sam"]).default("none"),
      feather: z.number().int().min(0).max(50).default(3)
    })
    .default({}),

  views: z
    .object({
      count: z.number().int().min(1).max(64).default(12),
      elev: z.number().min(-45).max(45).default(10),
      fov: z.number().min(10).max(80).default(35),
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
      res: z.number().int().min(128).max(1024).default(512)
    })
    .default({}),

  recon: z
    .object({
      method: z.enum(["poisson", "alpha-shape", "none"]).default("poisson"),
      voxel: z.number().min(0.0005).max(0.05).default(0.006)
    })
    .default({}),

  mesh: z
    .object({
      targetTris: z.number().int().min(100).max(100000).default(2000),
      thickness: z.number().min(0).max(0.2).default(0.02),
      export: z.enum(["gltf", "glb"]).default("gltf")
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
          maxTokens: z.number().int().min(16).max(512).default(200)
        })
        .default({})
    })
    .default({})
});

export type BakeSpec = z.infer<typeof BakeSpecV0_1>;

export function parseBakeSpec(input: unknown): BakeSpec {
  return BakeSpecV0_1.parse(input);
}
