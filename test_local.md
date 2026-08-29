# Smoke-testing the graph before it costs anything

Three levels, cheapest first. Do them in order; each one catches a class of
failure the next one would otherwise waste a GPU minute on.

---

## Level 0 — offline, no ComfyUI, no GPU (seconds)

```bash
cd texture-endpoint
python _gen_workflows.py     # regenerates + structurally validates both graphs
node selftest.mjs            # PNG decoder, seam check, prompt file, workflow patching
```

`_gen_workflows.py` prints `PROBLEMS: none` when every node's input names match
the schema table, every link points at a node id and slot that exist, and no node
is orphaned from a `SaveImage`. `selftest.mjs` synthesises a tileable PNG and a
deliberately seamed one and asserts the check calls them correctly, then confirms
`PROMPTS.md` parses to 12 materials and that both workflows patch cleanly.

Neither can tell you a *node class name* is wrong — only a live ComfyUI can.
That is level 1.

---

## Level 1 — a GPU pod running the built image (5-10 min, ~$0.30)

Cheapest honest test. Launch a **Pod** (not serverless) from the image you just
built, on any 24 GB GPU, exposing port 8188.

```bash
# inside the pod
python /comfyui/main.py --listen 0.0.0.0 --port 8188
```

### 1a. Confirm the custom nodes registered

```bash
curl -s localhost:8188/object_info | python -c "
import json,sys
d=json.load(sys.stdin)
for n in ['SeamlessTile','MakeCircularVAE','OffsetImage','CircularVAEDecode','Deep Bump (mtb)',
          'ImageStitch','ImageCrop','ImageScale','UpscaleModelLoader','ImageUpscaleWithModel']:
    print(('OK  ' if n in d else 'MISS'), n)
"
```

Every line must say `OK`. A `MISS` on `Deep Bump (mtb)` usually means comfy_mtb's
dependency install died (it pulls onnxruntime-gpu and rembg) — check the build
log rather than the pod.

`SeamlessTile` registering is **not** sufficient — the Comfy Registry's only
published version of that pack is broken on current ComfyUI. Confirm the pinned
source actually landed:

```bash
grep -n 'model.clone()\|deepcopy' /comfyui/custom_nodes/ComfyUI-seamless-tiling/SeamlessTile.py
```

You want `model.clone()` on the MODEL path. If you see `copy.deepcopy(model)`,
the registry version is installed and `SeamlessTile` will fail at execution with
`'NoneType' object is not callable`. The Dockerfile has a `grep -q` guard that
fails the build in that case, so this should be impossible — check it anyway if
a job dies on node 2.

`ImageCrop` is marked deprecated in current ComfyUI (superseded by `ImageCropV2`,
which takes a `BOUNDING_BOX` input that is awkward in API JSON). Deprecated nodes
still register and execute. If a future base image ever removes it, the fix is to
swap the three `ImageCrop` nodes for `ImageCropV2` and feed each a bounding box.

### 1b. Confirm every model file is visible to its loader

```bash
curl -s localhost:8188/object_info/CheckpointLoaderSimple | grep -o 'Juggernaut[^"]*'
curl -s localhost:8188/object_info/LoraLoader | grep -o 'texture-synthesis[^"]*'
curl -s localhost:8188/object_info/UpscaleModelLoader | grep -o '[A-Za-z0-9_.-]*PBRify[^"]*'
ls -l /comfyui/models/deepbump/deepbump256.onnx
```

The upscaler line must list all five PBRify files. The names in
`workflow.texture.api.json` must match **byte for byte** — note the inconsistent
punctuation in Kim2091's own filenames: `4x-PBRify-UpscalerV4.safetensors` uses a
hyphen, `4x-PBRify_UpscalerSPANV4.pth` uses an underscore.

### 1c. Run the fast graph, then the full graph

```bash
python - <<'EOF'
import json, urllib.request
wf = json.load(open('workflow.texture.fast.api.json'))
for n in wf.values():
    if n['inputs'].get('text') == '__POSITIVE__':
        n['inputs']['text'] = ('colormap, seamless tileable texture of weathered medieval castle '
                               'brick wall, orthographic top-down view, even diffuse studio lighting, '
                               'no shadows, photorealistic material scan, 8k')
    if n['inputs'].get('text') == '__NEGATIVE__':
        n['inputs']['text'] = 'perspective, horizon, sky, cast shadow, border, watermark, text, blur'
    if n['class_type'] == 'KSampler':
        n['inputs']['seed'] = 12345
req = urllib.request.Request('http://localhost:8188/prompt',
        data=json.dumps({'prompt': wf}).encode(), headers={'Content-Type':'application/json'})
print(urllib.request.urlopen(req).read().decode())
EOF
```

A non-2xx response here returns ComfyUI's validation error naming the offending
node and input — that is the message you want, and it is why level 1 exists.

Then run the same thing against `workflow.texture.api.json`. Outputs land in
`/comfyui/output/`.

### 1d. Eyeball the four things that matter

| file | what to look at |
| --- | --- |
| `albedo1k_*.png` | is it a flat top-down material, or a photo of an object? |
| `seamcheck_*.png` | this is the tile rolled 50/50. **A visible cross means the tiling failed.** Nothing else in this list matters until this is clean. |
| `albedo2k_*.png` | same framing as albedo1k, 2048², sharper. If it looks *shifted* relative to albedo1k, the wrap-pad offset arithmetic is off (see below). |
| `normal_*.png` / `normal_deepbump_*.png` | pick a winner. PBRify is the consistent set (its roughness and height were trained alongside it); DeepBump is the second opinion. |

### 1e. Verify the wrap-pad arithmetic in one command

This is the fiddliest part of the graph and the easiest to break by editing a
constant, so check it directly rather than by eye:

```bash
python - <<'EOF'
from PIL import Image, ImageChops
import glob
a = Image.open(sorted(glob.glob('/comfyui/output/albedo1k_*.png'))[-1]).convert('RGB').resize((2048,2048), Image.LANCZOS)
b = Image.open(sorted(glob.glob('/comfyui/output/albedo2k_*.png'))[-1]).convert('RGB')
# same alignment => difference is detail only; a misalignment shows as ghosting
d = ImageChops.difference(a, b)
print('bbox', d.getbbox(), 'extrema', d.getextrema())
EOF
```

The two must be *aligned*, not identical — the 2K has real added detail. What you
are ruling out is a half-tile ghost, which is what an off-by-one in the
`ImageCrop` x/y or the `OffsetImage` percentage produces.

The chain is: 1024 tile → stitched into a 2048² 2×2 grid (exactly periodic) →
cropped 1152² at (448,448), so the inner 1024 is the tile shifted **+512** with a
genuine 64 px wrap border → ×4 → 4608² → resampled to 2304² (border now 128) →
cropped 2048² at (128,128), shift now **+1024** → `OffsetImage` 50/50 undoes
exactly that. Change any one of `PAD`, `CROP1_XY` or the net scale in
`_gen_workflows.py` and all four numbers move together.

---

## Level 2 — the deployed serverless endpoint

That is `test_endpoint.mjs`; see `CHECKLIST.md` steps 9-12.

---

## Known failure modes and what they mean

| symptom | cause |
| --- | --- |
| `SeamlessTile` / node 2: `'NoneType' object is not callable` | The Comfy Registry version (1.0.0, published 2024-05-23, never republished) is installed. It calls `copy.deepcopy(model)`, which cannot copy a ModelPatcher on current ComfyUI. Upstream issue #17; fixed only in git commit `9225ed5`. The Dockerfile installs that commit by sha instead of using the registry. |
| `MakeCircularVAE` / node 8: the same error | `copy_vae` is set to `Make a copy`. Upstream never fixed the VAE half — that branch still calls `copy.deepcopy(vae)`, and `comfy.sd.VAE` owns a `.patcher` ModelPatcher. Both workflows must keep `copy_vae: "Modify in place"`. `CircularVAEDecode` has no in-place option at all and must not be used. |
| Visible cross in `seamcheck` | `SeamlessTile` or `MakeCircularVAE` not applied. Both are required — the UNet alone leaves a few drifting pixels at each edge that the VAE decoder bakes in. |
| Seam only on one axis | `tiling` set to `x_only` / `y_only` somewhere. Both nodes want `enable`. |
| Faint seam at 2K but clean at 1K | wrap-pad branch is bypassed or `PAD` is too small for the upscaler's receptive field. Raise `PAD` (and therefore `CROP1`) in `_gen_workflows.py` and regenerate. |
| `Deep Bump (mtb)` errors on model not found | `deepbump256.onnx` is not at `/comfyui/models/deepbump/`. comfy_mtb resolves it through `get_model_path("deepbump", ...)`, which has no registered folder and falls back to `<comfy>/models/deepbump`. |
| Upscale OOM | `4x-PBRify-UpscalerV4.safetensors` is a DAT model at 4608². Switch node `16` to `4x-PBRify_UpscalerSPANV4.pth` (the default) or `4x-UltraSharp.pth`. |
| Textures look like product photos of a material sample | LoRA strength too low or the negative prompt is not carrying `single object, centered composition`. |
