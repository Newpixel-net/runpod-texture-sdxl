# Phase 1 summary — what is verified, what is assumed

Authored 2026-08-29. Nothing here has been built, deployed, or run against a GPU.
Every external reference below was checked live on that date; every judgement call
is flagged.

## Files

### `Dockerfile`
`FROM runpod/worker-comfyui:5.8.6-base`, both node packs, nine model files.

- **Verified.** 5.8.6-base is the newest `-base` tag actually *published to Docker
  Hub* (tags API, pushed 2026-06-17); GitHub release 5.8.7 exists with no image,
  so do not bump blindly. `comfy-node-install` and
  `comfy model download --relative-path` syntax taken from RunPod's
  `docs/customization.md`. Registry ids `comfyui-seamless-tiling` and `comfy-mtb`
  returned live by `api.comfy.org/nodes/<id>`, both `NodeVersionStatusActive`.
  Every model URL HEAD-checked: 302 to 200, unauthenticated, byte sizes recorded
  in the file's comments.
- **Assumed.** That the build succeeds — it has never been run. comfy-mtb's
  dependency install (onnxruntime-gpu, rembg, imageio_ffmpeg) is the fragile
  layer. Image size ~19-20 GB is arithmetic, not measured.

### `workflow.texture.api.json`
40-node API graph. Outputs: albedo1k, seamcheck, albedo2k, normal, roughness,
height, normal_deepbump.

- **Verified.** Every `class_type` and every input name read from source, not from
  docs: `SeamlessTile` / `MakeCircularVAE` / `CircularVAEDecode` / `OffsetImage`
  from `spinagon/ComfyUI-seamless-tiling@master/SeamlessTile.py` and
  `__init__.py`; `Deep Bump (mtb)` from `melMass/comfy_mtb@main/nodes/deep_bump.py`
  plus the label rule in `__init__.py`, cross-checked against the repo's generated
  `node_list.json`; core nodes from ComfyUI master `nodes.py`,
  `comfy_extras/nodes_images.py`, `comfy_extras/nodes_upscale_model.py`.
  Structurally validated by `_gen_workflows.py`: input names match the schema,
  every link resolves to an existing node and slot, nothing is orphaned.
- **Assumed.** The graph has never been executed. Structural validity is not
  runtime validity. `scheduler: "normal"` is my choice — the plan fixed only
  euler, 50-60 steps, cfg 6-7, 1024 square. LoRA strength 0.7 is the plan's
  number, untested aesthetically.

### `workflow.texture.fast.api.json`
12-node albedo-only graph: the shared head plus the seam check.
Same generator, same validator, same caveats.

### `_gen_workflows.py`
Generator and structural validator for both graphs. Runs clean: `PROBLEMS: none`.
Kept in-tree so the wrap-pad arithmetic is reproducible after any edit.

### `test_endpoint.mjs`
Dependency-free node driver: POST `/run`, poll `/status`, save every map under
`out/<material>/`, auto-check tileability.

- **Verified.** Request/response contract from the worker-comfyui README: in
  `{"input":{"workflow":{...}}}`, out
  `{"output":{"images":[{filename,type,data}]}}` for 5.0.0 and later. The PNG
  decoder (pure `node:zlib`, no dependencies) and the seam check are exercised
  offline by `selftest.mjs` against synthetic tileable and deliberately-seamed
  images, PNG filter types 0, 1 and 4.
- **Assumed.** The `/cancel/<id>` timeout path is written from the documented API,
  not exercised. S3 mode (`type: "s3_url"`) is handled but untested.

### `selftest.mjs`
Offline test of the decoder, the seam check, `PROMPTS.md` parsing and workflow
patching. 20/20 checks pass on node v24. The seamed synthetic scores 40.70
against a 13.92 limit; the tileable one scores 8.72.

- **Assumed.** The thresholds (`TILE_RATIO` 1.6, `TILE_FLOOR` 2.0) are calibrated
  on synthetic noise only. Real materials — gravel, leaf litter — may need
  `TILE_RATIO` raised. That is what the first proving round is for.

### `PROMPTS.md`
Twelve materials with full positive and negative prompts, plus the
machine-readable JSON fence the harness reads (one source of truth).

- **Verified.** The LoRA trigger token `colormap` and the full token list come
  from the model card on HuggingFace.
- **Assumed.** Prompt *quality* is entirely unproven. The template follows the
  researched pattern — top-down, flat lighting, no shadows, seamless — but no
  image has been generated.

### `test_local.md`
Three-level smoke test, cheapest first, plus a failure-mode table.
Level 0 is the set of commands I actually ran. Levels 1 and 2 are written, not
performed.

### `CHECKLIST.md`
Path A and Path B deploy steps, the file-to-directory map, the request shape.

- **Verified.** The serverless volume mount `/runpod-volume/models/...` and the
  constraint that **a network volume cannot carry custom nodes** are both stated
  explicitly in RunPod's `docs/customization.md`. That materially changes Path B
  and is called out in the file.
- **Assumed.** The Pod-side volume mount `/workspace` is RunPod's documented
  default but I did not confirm it in the console. Build time 20-40 min is an
  estimate.

## Two deliberate deviations from `PLAN.md`

**1. The wrap pad does not exist as a node, so I built one.**
The plan's branch B says "wrap-pad, PBRify upscale, crop-back 2048". No installed
pack ships a wrap or circular pad node — core `ImagePadForOutpaint` pads with
grey, which is exactly the artefact we are avoiding, and neither
seamless-tiling nor mtb has an equivalent. I searched rather than guessed, then
built the pad out of core nodes:

`ImageStitch` twice gives a 2048-square 2x2 grid, which is exactly periodic. Crop
1152 square at (448,448): the inner 1024 is the tile shifted **+512**, surrounded
by a genuine 64 px wrap border. Upscale x4 to 4608, resample to 2304 (border now
128), crop 2048 square at (128,128) — shift is now **+1024** — and a single
`OffsetImage` 50/50 undoes exactly that.

The 2304 plate is then reused by all three PBRify 1x models and by DeepBump, so
the PBR maps get the same wrap context for free instead of a second pad chain.
`test_local.md` section 1e has a one-command alignment check, because an
off-by-one here produces a half-tile ghost rather than an error.

**2. DeepBump cannot produce roughness.**
The plan's branch C says "DeepBump normal + height + roughness". The graph uses
the PBRify CC0 trio for normal, roughness and height — that is exactly how
NVIDIA's own `ComfyUI-RTX-Remix/workflows/restapi_pbrify.json` drives them, via
core `UpscaleModelLoader` + `ImageUpscaleWithModel` with those filenames, which I
read to confirm. One DeepBump node is kept, producing a second-opinion normal, so
the first proving round can pick a winner and then delete the loser.

## Things I could not verify

- **That spandrel loads the 1x PBRify `.pth` files.** Strong indirect evidence —
  NVIDIA's shipped workflow loads those exact filenames with the core loader —
  but I did not load one.
- **`ImageCrop` is marked `is_deprecated=True` in current ComfyUI master.** It is
  still registered and still executes. `ImageCropV2` replaces it with a
  `BOUNDING_BOX` input that is awkward in API JSON, so I chose the deprecated
  node deliberately and documented the migration in `test_local.md`.
- **The ComfyUI version inside `5.8.6-base`.** I read schemas from ComfyUI master,
  which may be ahead of the image. `ImageStitch` — upstreamed from KJNodes in
  mid-2025 — is the only node here recent enough to be worth confirming at
  level 1.
- **`4x-PBRify-UpscalerV4.safetensors` is a DAT model.** I read the safetensors
  metadata header from the downloaded zip: `split_size`, `channel_interaction`,
  `upscale: 4`. DAT at 4608 square is slow, so the graph defaults to the SPAN
  model (`4x-PBRify_UpscalerSPANV4.pth`, 9 MB) and bakes DAT and 4x-UltraSharp as
  drop-in alternates on node `16`.
- **Cost.** Zero spent. Phase 1 was authoring only: no cloud call, no purchase.

## Verified download URLs (all unauthenticated, HEAD-checked 2026-08-29)

| file | URL | bytes |
| --- | --- | --- |
| Juggernaut XI (SDXL) | `https://huggingface.co/RunDiffusion/Juggernaut-XI-v11/resolve/main/Juggernaut-XI-byRunDiffusion.safetensors` | 7,105,350,536 |
| texture LoRA | `https://huggingface.co/dog-god/texture-synthesis-sdxl-lora/resolve/main/texture-synthesis-topdown-base-condensed.safetensors` | 11,939,764 |
| PBRify_Remix (zip of 5 models) | `https://github.com/Kim2091/PBRify_Remix/releases/download/v1.7.2_ComfyOnly/PBRify_Remix_1.7.2_ComfyUI_ONLY.zip` | 72,544,643 |
| 4x-UltraSharp | `https://huggingface.co/uwg/upscaler/resolve/main/ESRGAN/4x-UltraSharp.pth` | 66,961,958 |
| DeepBump ONNX | `https://github.com/HugoTini/DeepBump/raw/master/deepbump256.onnx` | 26,706,979 |

Nothing needs a token. The `Dockerfile` documents the build-secret pattern for a
future Civitai or gated source rather than carrying a placeholder URL.
