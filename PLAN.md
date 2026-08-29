# Texture Endpoint — Work Plan (owner: lane2, builder: Opus agent, supervisor: lane2)

GOAL: a RunPod serverless endpoint that produces GAME-READY REALISTIC TEXTURES:
photoreal materials (stone/brick/wood/grass/metal/fabric/ground), PERFECTLY
SEAMLESS/TILEABLE, with PBR maps (normal/roughness/height) and a 2K/4K path.
Verdict basis: Opus research 29 Aug — SDXL + circular-padding is the only
reliable tiling method (Ubisoft CHORD's own choice); DiT models (FLUX/Qwen/Z)
cannot tile reliably. Full report in session transcript + memory.

## Phase 1 — AUTHORING (no cloud, no cost; Opus agent builds, lane2 reviews)
Deliverables in this folder:
1. `Dockerfile` — FROM runpod/worker-comfyui:<latest>-base;
   comfy-node-install: comfyui-seamless-tiling (spinagon), comfyui-mtb
   (DeepBump); model downloads: Juggernaut XL (SDXL realism ckpt),
   dog-god/texture-synthesis-sdxl-lora, PBRify_Remix models (CC0:
   upscaler + normal + roughness + height), 4x-UltraSharp fallback.
   Exact URLs verified by the agent (HF/Civitai direct links that work
   from a Dockerfile without auth, or documented HF_TOKEN need).
2. `workflow.texture.api.json` — ComfyUI API graph:
   CheckpointLoader -> SeamlessTile(X+Y) -> LoraLoader(0.7) ->
   KSampler(euler, 50-60 steps, cfg 6-7, 1024x1024) -> MakeCircularVAE ->
   VAEDecode -> [branch A: OffsetImage(50%) seam-check output]
   [branch B: wrap-pad -> PBRify upscale -> crop-back 2048]
   [branch C: DeepBump normal + height + roughness from albedo]
   Outputs: albedo2k, seamcheck, normal, roughness, height.
3. `workflow.texture.fast.api.json` — same minus PBR branch (albedo-only,
   quick iteration).
4. `test_local.md` — how to smoke-test the graph in a local/pod ComfyUI.
5. `test_endpoint.mjs` — node script: submits N material prompts, saves all
   maps, auto-verifies tileability (pixel-compare left/right + top/bottom
   edges; fail if mean edge delta > threshold).
6. `PROMPTS.md` — 12 starter material prompts (game-relevant: castle brick,
   mossy stone, meadow grass, wood planks, dirt path, roof tiles...) using
   the researched template: "texture of X, ..., orthographic top-down, even
   diffuse lighting, no shadows, seamless" + negatives.
7. `CHECKLIST.md` — deploy + verify steps, in the style of the four proven
   media endpoints.

## Phase 2 — DEPLOY (needs operator/console; lane2 drives)
- Path A (preferred, per SOP "bake <50GB"): GitHub repo + RunPod GitHub
  integration build. OPEN QUESTION for operator: which GitHub account/repo
  to host it under (RunPod must be connected to it).
- Path B (fallback, no repo): deploy runpod/worker-comfyui base image as a
  custom endpoint + network volume with models/ + custom_nodes/ uploaded.
  COST: volume pins one datacenter + silently filters GPUs (known trap) —
  acceptable for a first proving round, migrate to baked later.
- Config: 24GB GPU tier 1st, max workers 2, idle timeout 120s, no active.

## Phase 3 — PROVE (lane2)
- Cold + warm timing (measure the SECOND cold start, per SOP).
- Run test_endpoint.mjs: 12 materials; tileability auto-check must pass 12/12.
- Visual grid delivered to operator; 2-3 iterate rounds on prompt/LoRA
  strength if needed.
- Record endpoint id + settings in memory + this folder.

## Laws (from SOPs, binding)
- Measure the second cold start before designing around cold-start numbers.
- PATCH-then-reread any GPU list change; count what survived.
- Volume = datacenter pin + GPU filter; detach with networkVolumeId "".
- The console Requests editor appends to prefilled JSON — use REST + key.
- CHORD (Ubisoft) is research-only license: benchmark with it, never ship.
