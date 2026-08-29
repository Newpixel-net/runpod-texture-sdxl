# syntax=docker/dockerfile:1
#
# Seamless game-texture endpoint for RunPod serverless.
#
# Base image tag verified 2026-08-29: 5.8.6-base is the newest "-base" tag
# actually PUBLISHED to Docker Hub (pushed 2026-06-17, ~11.9 GB). GitHub release
# 5.8.7 exists but no 5.8.7 images have been pushed, so do not bump blindly.
FROM runpod/worker-comfyui:5.8.6-base

# --- custom nodes -----------------------------------------------------------
# Registry ids verified against https://api.comfy.org/nodes/<id>:
#   comfyui-seamless-tiling -> spinagon/ComfyUI-seamless-tiling (SeamlessTile,
#                              MakeCircularVAE, CircularVAEDecode, OffsetImage)
#   comfy-mtb               -> melMass/comfy_mtb ("Deep Bump (mtb)")
# comfy-mtb pulls heavy deps (onnxruntime-gpu, rembg, imageio_ffmpeg ...); it is
# the single slowest layer of this build. If it ever breaks the build, dropping
# it only costs the normal_deepbump comparison output.
RUN comfy-node-install comfyui-seamless-tiling comfy-mtb

# --- checkpoint -------------------------------------------------------------
# Juggernaut XI (SDXL, RunDiffusion). Public, ungated, no token: verified with a
# HEAD request -> 302 to the HF CDN -> 200, 7,105,350,536 bytes.
RUN comfy model download \
      --url https://huggingface.co/RunDiffusion/Juggernaut-XI-v11/resolve/main/Juggernaut-XI-byRunDiffusion.safetensors \
      --relative-path models/checkpoints \
      --filename Juggernaut-XI-byRunDiffusion.safetensors

# --- texture LoRA -----------------------------------------------------------
# dog-god/texture-synthesis-sdxl-lora, Apache-2.0. "topdown" is the flat-texture
# variant (the "3d" variant renders objects, not tiles). Trigger token: colormap.
RUN comfy model download \
      --url https://huggingface.co/dog-god/texture-synthesis-sdxl-lora/resolve/main/texture-synthesis-topdown-base-condensed.safetensors \
      --relative-path models/loras \
      --filename texture-synthesis-topdown-base-condensed.safetensors

# --- PBRify_Remix (CC0) -----------------------------------------------------
# Shipped only as a release zip, not as loose release assets. Contents verified
# by downloading v1.7.2_ComfyOnly (72,544,643 bytes):
#   1x-PBRify_Height.pth              8,938,652
#   1x-PBRify_NormalV3.pth            8,942,931
#   1x-PBRify_RoughnessV2.pth         8,938,652
#   4x-PBRify-UpscalerV4.safetensors  139,793,020  (DAT arch - accurate, slow)
#   4x-PBRify_UpscalerSPANV4.pth        9,016,813  (SPAN arch - fast, default)
# All five land in models/upscale_models and load through the core
# UpscaleModelLoader / ImageUpscaleWithModel pair - that is exactly how NVIDIA's
# own ComfyUI-RTX-Remix workflow (workflows/restapi_pbrify.json) drives them.
# curl does not exist in the base image (first build failed here, exit 127) -
# python3 + urllib is the one downloader the image is guaranteed to carry,
# and urllib follows the GitHub-release 302 to the CDN.
RUN set -eux; \
    mkdir -p /comfyui/models/upscale_models; \
    python3 -c "import urllib.request; urllib.request.urlretrieve('https://github.com/Kim2091/PBRify_Remix/releases/download/v1.7.2_ComfyOnly/PBRify_Remix_1.7.2_ComfyUI_ONLY.zip', '/tmp/pbrify.zip')"; \
    python3 -c "import zipfile; zipfile.ZipFile('/tmp/pbrify.zip').extractall('/comfyui/models/upscale_models')"; \
    rm -f /tmp/pbrify.zip; \
    ls -l /comfyui/models/upscale_models

# --- generic upscaler fallback ---------------------------------------------
# 4x-UltraSharp (ESRGAN arch, always loadable by spandrel). Verified public:
# 66,961,958 bytes.
RUN comfy model download \
      --url https://huggingface.co/uwg/upscaler/resolve/main/ESRGAN/4x-UltraSharp.pth \
      --relative-path models/upscale_models \
      --filename 4x-UltraSharp.pth

# --- DeepBump ONNX weights --------------------------------------------------
# comfy_mtb resolves this via get_model_path("deepbump", "deepbump256.onnx"),
# which falls back to <comfy>/models/deepbump/deepbump256.onnx when no
# folder_paths entry exists (it does not register one). Baking it lets the
# workflow run with auto_download=false, so no worker ever reaches the internet
# mid-request. 26,706,979 bytes.
RUN comfy model download \
      --url https://github.com/HugoTini/DeepBump/raw/master/deepbump256.onnx \
      --relative-path models/deepbump \
      --filename deepbump256.onnx

# --- optional: gated / token-protected sources ------------------------------
# Nothing above needs a token. If a future checkpoint does (Civitai always does,
# and gated HF repos do), pass it as a build secret rather than baking it:
#   ARG CIVITAI_TOKEN
#   RUN --mount=type=secret,id=civitai_token \
#       curl -fL -H "Authorization: Bearer $(cat /run/secrets/civitai_token)" \
#         -o /comfyui/models/checkpoints/<name>.safetensors \
#         "https://civitai.com/api/download/models/<versionId>"
# Never use ARG+ENV for a token: it survives in the image history.
