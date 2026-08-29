"""Generates the two API-format workflow JSONs. Kept in-tree so the graph math
(the wrap-pad offsets) is reproducible rather than hand-copied, and so the
structural validator at the bottom can be re-run after any edit."""
import json
from collections import OrderedDict

CKPT = "Juggernaut-XI-byRunDiffusion.safetensors"
LORA = "texture-synthesis-topdown-base-condensed.safetensors"
UPSCALER = "4x-PBRify_UpscalerSPANV4.pth"
NORMAL_M = "1x-PBRify_NormalV3.pth"
ROUGH_M = "1x-PBRify_RoughnessV2.pth"
HEIGHT_M = "1x-PBRify_Height.pth"

BASE = 1024                     # sampled tile
PAD = 64                        # wrap margin at 1x
CROP1 = BASE + 2 * PAD          # 1152
CROP1_XY = BASE // 2 - PAD      # 448 -> core lands at +512 (exactly half a tile)
SCALE = 4                       # upscale model factor
NET = 2                         # net magnification we keep
PAD2 = PAD * NET                # 128
DOWN = CROP1 * NET              # 2304 (padded 2K plate)
OUT = BASE * NET                # 2048


def node(cls, inputs, title):
    return OrderedDict([("inputs", OrderedDict(inputs)),
                        ("class_type", cls),
                        ("_meta", {"title": title})])


def core():
    """Shared head: checkpoint -> circular UNet/VAE -> LoRA -> sample -> decode."""
    g = OrderedDict()
    g["1"] = node("CheckpointLoaderSimple", [("ckpt_name", CKPT)], "Load SDXL checkpoint")
    # Circular padding is applied to the UNet BEFORE the LoRA patch, so the LoRA
    # loader clones an already-circular model.
    g["2"] = node("SeamlessTile", [
        ("model", ["1", 0]),
        ("tiling", "enable"),
        ("copy_model", "Make a copy"),
    ], "Seamless Tile (X+Y)")
    g["3"] = node("LoraLoader", [
        ("model", ["2", 0]),
        ("clip", ["1", 1]),
        ("lora_name", LORA),
        ("strength_model", 0.7),
        ("strength_clip", 0.7),
    ], "Texture synthesis LoRA")
    g["4"] = node("CLIPTextEncode", [("text", "__POSITIVE__"), ("clip", ["3", 1])], "Positive")
    g["5"] = node("CLIPTextEncode", [("text", "__NEGATIVE__"), ("clip", ["3", 1])], "Negative")
    g["6"] = node("EmptyLatentImage", [("width", BASE), ("height", BASE), ("batch_size", 1)],
                  "Empty latent 1024")
    g["7"] = node("KSampler", [
        ("model", ["3", 0]),
        ("seed", 0),
        ("steps", 55),
        ("cfg", 6.5),
        ("sampler_name", "euler"),
        ("scheduler", "normal"),
        ("positive", ["4", 0]),
        ("negative", ["5", 0]),
        ("latent_image", ["6", 0]),
        ("denoise", 1.0),
    ], "KSampler")
    # The VAE decoder must be circular too, or the last few pixels of each edge
    # drift and the tile fails at the seam even though the latent was tileable.
    #
    # copy_vae MUST stay "Modify in place". The alternative branch of this node
    # is `copy.deepcopy(vae)`, and comfy.sd.VAE owns a .patcher ModelPatcher,
    # which current ComfyUI cannot deepcopy - the same upstream bug that took
    # SeamlessTile down with "'NoneType' object is not callable". Upstream fixed
    # only the MODEL path (commit 9225ed5); the VAE path is still broken, and
    # "Modify in place" is the branch that never calls deepcopy.
    #
    # Mutating the cached VAE is safe here and nowhere near as dirty as it
    # sounds: every request this endpoint serves wants a circular VAE, the patch
    # only rebinds Conv2d._conv_forward so re-applying it is idempotent, and
    # node 9 is the only VAE consumer in the graph.
    g["8"] = node("MakeCircularVAE", [
        ("vae", ["1", 2]),
        ("tiling", "enable"),
        ("copy_vae", "Modify in place"),
    ], "Make Circular VAE")
    g["9"] = node("VAEDecode", [("samples", ["7", 0]), ("vae", ["8", 0])], "VAE Decode")
    g["10"] = node("SaveImage", [("images", ["9", 0]), ("filename_prefix", "albedo1k")],
                   "SAVE albedo1k")
    # Branch A - seam check. Rolling by 50/50 puts the four tile edges through
    # the middle of the frame; any seam shows up as a visible cross.
    g["11"] = node("OffsetImage", [("pixels", ["9", 0]), ("x_percent", 50.0), ("y_percent", 50.0)],
                   "Offset 50/50")
    g["12"] = node("SaveImage", [("images", ["11", 0]), ("filename_prefix", "seamcheck")],
                   "SAVE seamcheck")
    return g


def wrap_pad(g):
    """Branch B, part 1 - build a genuinely wrap-padded tile out of core nodes.

    None of the installed packs ships a circular/wrap pad node (core
    ImagePadForOutpaint pads with grey, not wrap), so we synthesise one: stitch
    the tile into a 2x2 grid, which is exactly periodic with period 1024, then
    crop a 1152x1152 window off-grid at (448,448). The window's inner 1024 is
    the tile shifted by +512 px; the 64 px border around it is real neighbouring
    content, so the upscaler never sees a zero-padded edge. The +512 shift is
    undone later by a single OffsetImage 50/50, which is exact at 1024 and 2048.
    """
    g["13"] = node("ImageStitch", [
        ("image1", ["9", 0]), ("direction", "right"), ("match_image_size", True),
        ("spacing_width", 0), ("spacing_color", "white"), ("image2", ["9", 0]),
    ], "Tile x2 horizontally")
    g["14"] = node("ImageStitch", [
        ("image1", ["13", 0]), ("direction", "down"), ("match_image_size", True),
        ("spacing_width", 0), ("spacing_color", "white"), ("image2", ["13", 0]),
    ], "Tile x2 vertically -> 2048 grid")
    g["15"] = node("ImageCrop", [
        ("image", ["14", 0]), ("width", CROP1), ("height", CROP1),
        ("x", CROP1_XY), ("y", CROP1_XY),
    ], "Wrap-padded tile 1152 (pad 64)")
    g["16"] = node("UpscaleModelLoader", [("model_name", UPSCALER)], "Load upscaler")
    g["17"] = node("ImageUpscaleWithModel", [("upscale_model", ["16", 0]), ("image", ["15", 0])],
                   "Upscale x4 -> 4608")
    # Down to a net 2x. Everything downstream reuses node 18: it is the padded
    # 2K plate, so the 1x PBR models get wrap context for free.
    g["18"] = node("ImageScale", [
        ("image", ["17", 0]), ("upscale_method", "lanczos"),
        ("width", DOWN), ("height", DOWN), ("crop", "disabled"),
    ], "Resample to 2304 (padded 2K)")
    return g


def crop_back(g, nid, src, prefix, title, down=None):
    """Crop the 128 px wrap margin off a 2304 plate and undo the +1024 shift.
    down=N inserts a lanczos resize to NxN before the save: RunPod drops the
    whole output payload (silently - COMPLETED with no output field) when the
    base64 response exceeds ~20MB, so per-request images must stay small."""
    a, b, c, d = str(nid), str(nid + 1), str(nid + 2), str(nid + 3)
    g[a] = node("ImageCrop", [
        ("image", src), ("width", OUT), ("height", OUT), ("x", PAD2), ("y", PAD2),
    ], "Crop back " + title)
    g[b] = node("OffsetImage", [("pixels", [a, 0]), ("x_percent", 50.0), ("y_percent", 50.0)],
                "Re-align " + title)
    save_src = b
    if down:
        g[d] = node("ImageScale", [
            ("image", [b, 0]), ("upscale_method", "lanczos"),
            ("width", down), ("height", down), ("crop", "disabled"),
        ], "Down to %d %s" % (down, title))
        save_src = d
    g[c] = node("SaveImage", [("images", [save_src, 0]), ("filename_prefix", prefix)],
                "SAVE " + prefix)
    return g


def full_graph():
    g = core()
    wrap_pad(g)

    g["22"] = node("UpscaleModelLoader", [("model_name", NORMAL_M)], "Load PBRify normal")
    g["23"] = node("ImageUpscaleWithModel", [("upscale_model", ["22", 0]), ("image", ["18", 0])],
                   "Normal (padded)")
    crop_back(g, 40, ["23", 0], "normal", "normal", down=BASE)

    g["27"] = node("UpscaleModelLoader", [("model_name", ROUGH_M)], "Load PBRify roughness")
    g["28"] = node("ImageUpscaleWithModel", [("upscale_model", ["27", 0]), ("image", ["18", 0])],
                   "Roughness (padded)")
    crop_back(g, 50, ["28", 0], "roughness", "roughness", down=BASE)

    g["32"] = node("UpscaleModelLoader", [("model_name", HEIGHT_M)], "Load PBRify height")
    g["33"] = node("ImageUpscaleWithModel", [("upscale_model", ["32", 0]), ("image", ["18", 0])],
                   "Height (padded)")
    crop_back(g, 60, ["33", 0], "height", "height", down=BASE)

    # DeepBump branch removed 2026-08-30: "Deep Bump (mtb)" is not registered
    # at runtime on the worker (comfy-mtb only registers nodes whose imports
    # succeed; its onnxruntime path fails there). It was only a second-opinion
    # normal - PBRify (node 23) is the primary. Re-add if mtb runtime is fixed.
    return g


def hires_graph():
    """2K albedo in its own request, alone, to stay under the response cap."""
    g = core()
    wrap_pad(g)
    crop_back(g, 19, ["18", 0], "albedo2k", "albedo hires")
    # core saves 10 (albedo1k) and 12 (seamcheck, fed by offset 11) are not
    # wanted here; prune them and anything that then reaches no SaveImage.
    for nid in ("10", "11", "12"):
        assert g[nid]["class_type"] in ("SaveImage", "OffsetImage"), nid
        del g[nid]
    return g


def fast_graph():
    """Albedo-only iteration graph: 1024 tile + seam check, no upscale, no PBR."""
    return core()


# class_type -> (exact required+optional input names, number of output slots)
SPEC = {
    "CheckpointLoaderSimple": (["ckpt_name"], 3),
    "SeamlessTile": (["model", "tiling", "copy_model"], 1),
    "LoraLoader": (["model", "clip", "lora_name", "strength_model", "strength_clip"], 2),
    "CLIPTextEncode": (["text", "clip"], 1),
    "EmptyLatentImage": (["width", "height", "batch_size"], 1),
    "KSampler": (["model", "seed", "steps", "cfg", "sampler_name", "scheduler",
                  "positive", "negative", "latent_image", "denoise"], 1),
    "MakeCircularVAE": (["vae", "tiling", "copy_vae"], 1),
    "VAEDecode": (["samples", "vae"], 1),
    "SaveImage": (["images", "filename_prefix"], 1),
    "OffsetImage": (["pixels", "x_percent", "y_percent"], 1),
    "ImageStitch": (["image1", "direction", "match_image_size", "spacing_width",
                     "spacing_color", "image2"], 1),
    "ImageCrop": (["image", "width", "height", "x", "y"], 1),
    "UpscaleModelLoader": (["model_name"], 1),
    "ImageUpscaleWithModel": (["upscale_model", "image"], 1),
    "ImageScale": (["image", "upscale_method", "width", "height", "crop"], 1),
    "Deep Bump (mtb)": (["image", "mode", "color_to_normals_overlap",
                         "normals_to_curvature_blur_radius",
                         "normals_to_height_seamless", "auto_download"], 1),
}


def validate(g, name):
    problems = []
    for nid, n in g.items():
        ct = n["class_type"]
        if ct not in SPEC:
            problems.append(name + ":" + nid + " unknown class_type " + ct)
            continue
        want = SPEC[ct][0]
        got = list(n["inputs"].keys())
        if sorted(got) != sorted(want):
            problems.append(name + ":" + nid + " " + ct + " inputs " + str(got) + " != " + str(want))
        for k, v in n["inputs"].items():
            if isinstance(v, list):
                if len(v) != 2 or not isinstance(v[0], str) or not isinstance(v[1], int):
                    problems.append(name + ":" + nid + "." + k + " malformed link " + str(v))
                    continue
                src, slot = v
                if src not in g:
                    problems.append(name + ":" + nid + "." + k + " -> missing node " + src)
                elif slot >= SPEC[g[src]["class_type"]][1]:
                    problems.append(name + ":" + nid + "." + k + " -> " + src + " has no slot " + str(slot))
    saves = [nid for nid, n in g.items() if n["class_type"] == "SaveImage"]
    if not saves:
        problems.append(name + ": no SaveImage")
    reachable, stack = set(), list(saves)
    while stack:
        nid = stack.pop()
        if nid in reachable:
            continue
        reachable.add(nid)
        for v in g[nid]["inputs"].values():
            if isinstance(v, list):
                stack.append(v[0])
    for nid in g:
        if nid not in reachable:
            problems.append(name + ":" + nid + " is orphaned (never reaches a SaveImage)")
    return problems


if __name__ == "__main__":
    problems = []
    for g, fn, label in ((full_graph(), "workflow.texture.api.json", "full"),
                         (fast_graph(), "workflow.texture.fast.api.json", "fast"),
                         (hires_graph(), "workflow.texture.hires.api.json", "hires")):
        problems += validate(g, label)
        with open(fn, "w", encoding="utf-8") as fh:
            json.dump(g, fh, indent=2)
            fh.write("\n")
        saves = sorted(n["inputs"]["filename_prefix"] for n in g.values()
                       if n["class_type"] == "SaveImage")
        print(label + ": " + str(len(g)) + " nodes -> " + fn + "  outputs=" + str(saves))
    print("PROBLEMS:", problems or "none")
