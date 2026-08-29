# Deploy + verify checklist

Phase 2 and 3 of `PLAN.md`. Nothing here has been executed — this is the script,
not a log. Tick items in place as they are done and record the endpoint id at the
bottom.

**Before anything:** run the level-0 offline checks from `test_local.md`. They
cost nothing and catch the mistakes that are most annoying to find on a GPU.

---

## Where every file must land in the ComfyUI tree

The image installs ComfyUI at `/comfyui`. A network volume mounts at
`/runpod-volume` and ComfyUI reads models from `/runpod-volume/models/...` there.

| file | directory | referenced by | size |
| --- | --- | --- | --- |
| `Juggernaut-XI-byRunDiffusion.safetensors` | `models/checkpoints/` | node `1` `CheckpointLoaderSimple.ckpt_name` | 7.11 GB |
| `texture-synthesis-topdown-base-condensed.safetensors` | `models/loras/` | node `3` `LoraLoader.lora_name` | 11.9 MB |
| `4x-PBRify_UpscalerSPANV4.pth` | `models/upscale_models/` | node `16` `UpscaleModelLoader.model_name` | 9.0 MB |
| `4x-PBRify-UpscalerV4.safetensors` | `models/upscale_models/` | alternate for node `16` (DAT, slower, sharper) | 139.8 MB |
| `1x-PBRify_NormalV3.pth` | `models/upscale_models/` | node `22` | 8.9 MB |
| `1x-PBRify_RoughnessV2.pth` | `models/upscale_models/` | node `27` | 8.9 MB |
| `1x-PBRify_Height.pth` | `models/upscale_models/` | node `32` | 8.9 MB |
| `4x-UltraSharp.pth` | `models/upscale_models/` | fallback for node `16` | 67.0 MB |
| `deepbump256.onnx` | `models/deepbump/` | node `37` `Deep Bump (mtb)` (path is a comfy_mtb fallback, not a registered folder) | 26.7 MB |
| ComfyUI-seamless-tiling @ `9225ed5` | `custom_nodes/` | nodes `2`, `8`, `11`, `20`, `25`, `30`, `35`, `39`. **Installed from git by sha, not from the Comfy Registry** — the registry's only version is broken on current ComfyUI. | — |
| comfy_mtb | `custom_nodes/` | node `37` | — |

Total baked model weight ≈ **7.4 GB**, image ≈ **19-20 GB**. Comfortably under the
"bake below 50 GB" SOP threshold, which is why Path A is preferred.

---

## Path A — GitHub repo + RunPod GitHub integration (preferred)

1. **Answer the open question first.** `PLAN.md` leaves the hosting account
   undecided. RunPod's GitHub integration only sees repos in an account it has
   been connected to, so the operator must name the account/org before step 2.
   Do not create a repo speculatively.
2. Create the repo (private is fine) and push `Dockerfile`,
   `workflow.texture.api.json`, `workflow.texture.fast.api.json`, `PROMPTS.md`,
   `test_endpoint.mjs`, `selftest.mjs`, `test_local.md`, `CHECKLIST.md`. The
   `Dockerfile` must be at the repo root.
3. RunPod console → **Serverless → New Endpoint → Import Git Repository**.
   Authorise the account from step 1, pick the repo and branch, set the
   Dockerfile path to `Dockerfile` and the build context to `/`.
4. Start the build. Expect **20-40 min** — most of it is the 7 GB checkpoint pull
   and comfy_mtb's dependency install. Watch the build log for:
   - `comfy-node-install comfy-mtb` finishing without a traceback;
   - the pinned seamless-tiling step printing its `ls -l` (its `grep -q model.clone()`
     guard fails the build if the wrong source ever lands);
   - the `ls -l /comfyui/models/upscale_models` line listing **five** files.
5. Endpoint config (per `PLAN.md`): GPU **24 GB tier first** (L4 / A5000 / 4090),
   **max workers 2**, **active workers 0**, **idle timeout 120 s**, execution
   timeout ≥ 900 s, FlashBoot on. No network volume — that is the whole point of
   Path A.
6. Jump to **Verify**.

## Path B — base image + network volume (fallback)

Use only if Path A is blocked on the GitHub question.

> **Read this before starting.** RunPod's own customization guide states a
> network volume is *"not suitable for installing custom nodes"* — ComfyUI does
> not scan `/runpod-volume/custom_nodes`. This graph is **built out of custom
> nodes** (`SeamlessTile`, `MakeCircularVAE`, `OffsetImage`, `Deep Bump (mtb)`),
> so a pure `runpod/worker-comfyui:5.8.6-base` + volume deployment **cannot run
> it**. Path B therefore means: a *thin* custom image carrying only the two node
> packs, plus a volume carrying the 7.4 GB of models.

1. Build a thin image — the `Dockerfile` with every `comfy model download` /
   PBRify block deleted, keeping `FROM`, `comfy-node-install comfy-mtb` and the
   pinned seamless-tiling block.
   Push it to a registry RunPod can pull from.
2. Create a network volume, ≥ 20 GB, in a datacenter that has 24 GB GPUs.
   **This pins the endpoint to that datacenter and silently filters the GPU
   list** — the known trap. Note which DC you chose.
3. Attach the volume to a temporary **Pod** and populate it:
   ```bash
   cd /workspace   # the volume mount point on a Pod
   mkdir -p models/checkpoints models/loras models/upscale_models models/deepbump
   wget -O models/checkpoints/Juggernaut-XI-byRunDiffusion.safetensors \
     https://huggingface.co/RunDiffusion/Juggernaut-XI-v11/resolve/main/Juggernaut-XI-byRunDiffusion.safetensors
   wget -O models/loras/texture-synthesis-topdown-base-condensed.safetensors \
     https://huggingface.co/dog-god/texture-synthesis-sdxl-lora/resolve/main/texture-synthesis-topdown-base-condensed.safetensors
   wget -O /tmp/pbrify.zip \
     https://github.com/Kim2091/PBRify_Remix/releases/download/v1.7.2_ComfyOnly/PBRify_Remix_1.7.2_ComfyUI_ONLY.zip
   python -c "import zipfile;zipfile.ZipFile('/tmp/pbrify.zip').extractall('models/upscale_models')"
   wget -O models/upscale_models/4x-UltraSharp.pth \
     https://huggingface.co/uwg/upscaler/resolve/main/ESRGAN/4x-UltraSharp.pth
   wget -O models/deepbump/deepbump256.onnx \
     https://github.com/HugoTini/DeepBump/raw/master/deepbump256.onnx
   ls -lR models
   ```
   The mount point differs by product: a **Pod** sees the volume at
   `/workspace`, a **serverless worker** sees the same volume at
   `/runpod-volume`. The `models/...` tree above is what both expect underneath.
4. Terminate the Pod. Create the serverless endpoint from the thin image, same
   settings as Path A step 5, plus **Advanced → Select Network Volume**.
5. If models are not found on the first request, set `NETWORK_VOLUME_DEBUG=true`
   on the endpoint and read the worker log — it prints the paths it scanned.
6. Migration note: once the GitHub question is answered, rebuild via Path A and
   detach the volume by PATCHing `networkVolumeId: ""`. **PATCH then re-read** and
   count what survived — the GPU list usually needs re-applying after the volume
   comes off.

---

## Verify (both paths)

7. **Health.** `curl -H "Authorization: Bearer $RUNPOD_API_KEY" https://api.runpod.ai/v2/$ENDPOINT_ID/health`
   Expect `workers.ready` to be 0 with no `unhealthy`.

8. **First request = first cold start.** Fire one material with the fast graph
   and *discard the timing*:
   ```bash
   ENDPOINT_ID=... RUNPOD_API_KEY=... node test_endpoint.mjs --fast --only "castle brick" --concurrency 1
   ```
   This proves the contract end to end: request shape
   `{"input":{"workflow":{...}}}` → response
   `{"output":{"images":[{"filename","type":"base64","data"}]}}`.

9. **Measure the SECOND cold start** (binding law). Wait past the 120 s idle
   timeout so the worker is torn down, then repeat step 8 and record
   `delayTime` + `executionTime` from `out/castle-brick/meta.json`. The first
   cold start includes a one-off image pull and is not the number to design
   around.

10. **Warm timing.** Immediately run a second material and record the same two
    numbers. Warm `executionTime` for the full graph is the figure that decides
    whether 12 materials is one batch or several.

11. **The real run — 12 materials, full graph:**
    ```bash
    ENDPOINT_ID=... RUNPOD_API_KEY=... node test_endpoint.mjs --seed 1000 --concurrency 2
    ```
    - `--seed 1000` makes the round reproducible (material *i* gets `1000+i`).
    - `--concurrency 2` matches max workers 2; going higher just queues.
    - Exit code 0 means **12/12 tileable and no job errors**. Anything else and
      the summary table names the failing materials with their seam numbers.
    - Outputs: `out/<material>/{albedo1k,albedo2k,seamcheck,normal,normal_deepbump,roughness,height}.png`
      plus `out/<material>/meta.json` and `out/report.json`.

12. **Judge the seam by eye as well as by number.** Open every
    `seamcheck.png`: the check compares one pixel column against another, which
    catches a hard discontinuity but not a soft tonal drift across the tile. The
    rolled image shows both.

13. **Deliver the grid** to the operator: the 12 `albedo2k.png` plus, for two or
    three materials, the full map set. Ask specifically whether PBRify or
    DeepBump normals look better — that decision removes a node from the graph.

14. **Iterate** (2-3 rounds max, per `PLAN.md`): adjust `strength_model` /
    `strength_clip` on node `3`, `cfg` and `steps` on node `7`, or the subject
    clauses in `PROMPTS.md`. Re-run with the same `--seed 1000` so changes are
    attributable.

15. **Record** the endpoint id, GPU tier, datacenter (Path B), second-cold-start
    and warm timings, and the chosen LoRA strength — here and in memory.

---

## Request shape, for anything that talks to this endpoint directly

```
POST https://api.runpod.ai/v2/<ENDPOINT_ID>/run          (async; poll /status/<id>)
POST https://api.runpod.ai/v2/<ENDPOINT_ID>/runsync      (sync; blocks)
Authorization: Bearer <RUNPOD_API_KEY>
Content-Type: application/json

{ "input": { "workflow": { <the contents of workflow.texture.api.json> } } }
```

The `workflow` value is the API-format graph itself — node ids as keys, each with
`class_type` and `inputs` — **not** wrapped in a `prompt` key and not the UI
export format. Substitute the two `__POSITIVE__` / `__NEGATIVE__` placeholders and
the KSampler `seed` before sending.

Response (worker-comfyui ≥ 5.0.0):

```json
{ "id": "...", "status": "COMPLETED", "delayTime": 0, "executionTime": 0,
  "output": { "images": [ { "filename": "albedo2k_00001_.png",
                            "type": "base64", "data": "iVBORw0KG..." } ] } }
```

One entry per `SaveImage` node — seven for the full graph, two for the fast one.
`type` becomes `"s3_url"` and `data` a URL if S3 env vars are ever configured.
`/run` has a ~10 MB request limit; the workflow JSON is ~10 KB, so only inbound
images would ever threaten it, and this graph takes none.

---

## Record

| field | value |
| --- | --- |
| endpoint id | _(fill in)_ |
| path used | _(A / B)_ |
| image tag | _(fill in)_ |
| GPU tier | _(fill in)_ |
| datacenter | _(Path B only)_ |
| 2nd cold start | _(delayTime + executionTime)_ |
| warm, full graph | _(executionTime)_ |
| tileability result | _(n/12)_ |
| LoRA strength chosen | _(fill in)_ |
