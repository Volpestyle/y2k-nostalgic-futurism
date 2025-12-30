Findings (ordered by severity)

Cutout API path writes the HF mask directly and never composites it onto the source image, so RMBG output becomes a raw mask instead of an RGBA cutout. Local runner applies the mask before writing, so API and local behavior diverge. See api_runners.py (line 75) and local_runners.py (line 55).
Depth API assumes HF returns base64 PNG, but the HF depth‑estimation task can return predicted_depth as a tensor, which would trip “missing base64 data” and fail the stage. This needs either ai‑kit support for tensor outputs or conversion in the API runner. See api_runners.py (line 103) plus ai‑kit HF parsing.
BakeSpec doesn’t allow passing per‑task parameters (e.g., mask_threshold) or size for cutout/depth. That blocks HF inference tuning through the UI/API even though the runner expects these keys. See bakespec.ts (line 6).
The API model picker uses capabilities.vision only, so models that can see but can’t generate images (e.g., Gemini text models) can still be selected for cutout/depth/views, leading to invalid GenerateImage calls. See CreateModelsPanel.tsx (line 406) and App.tsx.
Provider naming mismatch: HF docs say hf-inference, ai‑kit expects huggingface. If a user copies provider ids from HF docs into BakeSpec/config, ai‑kit won’t resolve it. Worth adding an alias or doc note.
Wiring requirements to confirm

HF token must be present in both the API server and worker environments or HF models won’t list / calls will fail. See ai_kit.go (line 63) and ai_kit_client.py (line 142).
Open questions / assumptions

Do your HF Depth Anything responses include depth as base64 PNG or only predicted_depth tensors? If it’s tensors, we need a conversion path.
Are you expecting RMBG to yield an RGBA cutout (like local), or is a raw mask acceptable downstream?
If you want, I can implement fixes for: (1) API cutout compositing, (2) depth tensor conversion, (3) BakeSpec/UX parameters, and (4) provider/task filtering.
