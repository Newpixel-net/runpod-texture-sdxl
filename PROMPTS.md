# Starter material prompts

Twelve game-relevant materials for the first proving round. The JSON fence at the
bottom is the machine-readable copy `test_endpoint.mjs` reads — **edit that fence,
not the table**, or the two will drift.

## The template

Every positive prompt is built from four fixed parts plus one variable part:

| part | text | why |
| --- | --- | --- |
| trigger | `colormap,` | dog-god texture LoRA two-token system; `colormap` selects the albedo/diffuse mode (the other tokens are `heighmap`, `roughmap`, `normalmap`, `specmap`, `ambmap`, `metalmap`) |
| framing | `seamless tileable texture of X` | states the goal in words as well as in the convolution padding |
| **subject** | *varies* | the material and its surface story |
| camera | `orthographic top-down view, flat lay, full frame surface, edge to edge coverage` | kills perspective, which is what turns a texture into a photo of a thing |
| light | `even diffuse studio lighting, no shadows, no specular highlights, uniform exposure, physically based albedo` | baked shadows are the second most common reason a texture is unusable in an engine (the first is a seam) |
| quality | `photorealistic material scan, ultra detailed surface, sharp focus, 8k` | pushes Juggernaut toward its scan-like register |

The shared negative is one string reused by all twelve; a few materials append one
or two extra terms. Its jobs, in order of importance:

1. kill perspective and horizon (`perspective, vanishing point, tilted, horizon, sky`)
2. kill lighting baked into the albedo (`cast shadow, directional light, specular highlight, glare, vignette, gradient`)
3. kill composition (`single object, centered composition, border, frame, watermark, text, logo`)
4. kill the styles the game bar rules out (`cartoon, illustration, painting, pixel art, low poly, 3d render`)

## The twelve

| # | material | subject clause |
| --- | --- | --- |
| 1 | Castle brick | weathered medieval fired-clay bricks, irregular hand-made shapes, pitted lime mortar |
| 2 | Mossy cobblestone | rounded river cobbles set in packed earth, damp moss in the joints |
| 3 | Meadow grass | dense short meadow grass, mixed blade lengths, scattered clover and dry stems |
| 4 | Wood planks | weathered oak deck planks, raised grain, splits, old iron nail heads |
| 5 | Dirt path | packed dry earth track, embedded pebbles, fine dust, faint boot scuffs |
| 6 | Clay roof tiles | overlapping terracotta barrel roof tiles, lichen spotting, chipped edges |
| 7 | Granite cliff rock | rough grey granite face, sharp fracture planes, quartz speckle, hairline cracks |
| 8 | Rusted iron plate | riveted wrought-iron plate, deep orange rust bloom, flaking paint remnants |
| 9 | Forest floor | fallen beech and oak leaf litter, twigs, dark humus, scattered acorns |
| 10 | Beach sand | fine wind-rippled quartz sand, shell fragments, subtle grain sparkle |
| 11 | Burlap fabric | coarse woven jute burlap, visible warp and weft, loose frayed fibres |
| 12 | Cracked mud | sun-baked desert clay hardpan, deep polygonal crack network, curled flakes |

## Tuning notes for the iterate rounds

- **LoRA strength** is 0.7 in both graphs (`LoraLoader.strength_model` /
  `strength_clip`, node `3`). Organic materials (grass, forest floor, moss) tend
  to want less, around 0.5; hard geometric materials (brick, tile, planks) hold
  up at 0.8.
- **cfg 6.5** is the middle of the plan's 6-7 band. Drop to 6.0 if the material
  looks over-contrasted or "posterised"; raise to 7.0 if it ignores the subject.
- **steps 55** is in the plan's 50-60 band; below ~45 the euler/normal pair
  leaves visible mush in fine detail like sand grain and fabric weave.
- If a material fails the seam check repeatedly, the usual cause is a **large
  feature** larger than half the tile (a single big rock, a plank running the
  full width). Add the feature scale to the subject clause ("small", "fine",
  "tightly packed") rather than fighting it with the negative prompt.

## Machine-readable

```json
[
  {
    "name": "castle brick",
    "positive": "colormap, seamless tileable texture of weathered medieval castle brick wall, irregular hand-made fired clay bricks, pitted lime mortar joints, subtle salt bloom and age staining, orthographic top-down view, flat lay, full frame surface, edge to edge coverage, even diffuse studio lighting, no shadows, no specular highlights, uniform exposure, physically based albedo, photorealistic material scan, ultra detailed surface, sharp focus, 8k",
    "negative": "perspective, vanishing point, tilted, angled view, horizon, sky, single object, centered composition, cast shadow, drop shadow, directional light, specular highlight, glare, reflection, vignette, gradient, uneven lighting, border, frame, watermark, text, letters, signature, logo, blur, depth of field, bokeh, jpeg artifacts, lowres, people, hands, cartoon, illustration, painting, pixel art, low poly, 3d render, arch, doorway, window"
  },
  {
    "name": "mossy cobblestone",
    "positive": "colormap, seamless tileable texture of mossy cobblestone ground, rounded river cobbles set in packed earth, damp green moss growing in the joints, wet stone sheen in the albedo only, orthographic top-down view, flat lay, full frame surface, edge to edge coverage, even diffuse studio lighting, no shadows, no specular highlights, uniform exposure, physically based albedo, photorealistic material scan, ultra detailed surface, sharp focus, 8k",
    "negative": "perspective, vanishing point, tilted, angled view, horizon, sky, single object, centered composition, cast shadow, drop shadow, directional light, specular highlight, glare, reflection, vignette, gradient, uneven lighting, border, frame, watermark, text, letters, signature, logo, blur, depth of field, bokeh, jpeg artifacts, lowres, people, hands, cartoon, illustration, painting, pixel art, low poly, 3d render, puddle, standing water"
  },
  {
    "name": "meadow grass",
    "positive": "colormap, seamless tileable texture of dense short meadow grass, mixed blade lengths and directions, scattered clover leaves and dry stems, tightly packed small scale, orthographic top-down view, flat lay, full frame surface, edge to edge coverage, even diffuse studio lighting, no shadows, no specular highlights, uniform exposure, physically based albedo, photorealistic material scan, ultra detailed surface, sharp focus, 8k",
    "negative": "perspective, vanishing point, tilted, angled view, horizon, sky, single object, centered composition, cast shadow, drop shadow, directional light, specular highlight, glare, reflection, vignette, gradient, uneven lighting, border, frame, watermark, text, letters, signature, logo, blur, depth of field, bokeh, jpeg artifacts, lowres, people, hands, cartoon, illustration, painting, pixel art, low poly, 3d render, lawn stripes, mowing lines, flowers"
  },
  {
    "name": "wood planks",
    "positive": "colormap, seamless tileable texture of weathered oak deck planks, raised wood grain, hairline splits, worn iron nail heads, narrow dark gaps between boards, orthographic top-down view, flat lay, full frame surface, edge to edge coverage, even diffuse studio lighting, no shadows, no specular highlights, uniform exposure, physically based albedo, photorealistic material scan, ultra detailed surface, sharp focus, 8k",
    "negative": "perspective, vanishing point, tilted, angled view, horizon, sky, single object, centered composition, cast shadow, drop shadow, directional light, specular highlight, glare, reflection, varnish, gloss, vignette, gradient, uneven lighting, border, frame, watermark, text, letters, signature, logo, blur, depth of field, bokeh, jpeg artifacts, lowres, people, hands, cartoon, illustration, painting, pixel art, low poly, 3d render"
  },
  {
    "name": "dirt path",
    "positive": "colormap, seamless tileable texture of packed dry earth track, fine dust over compacted soil, embedded small pebbles and grit, faint boot scuffs, orthographic top-down view, flat lay, full frame surface, edge to edge coverage, even diffuse studio lighting, no shadows, no specular highlights, uniform exposure, physically based albedo, photorealistic material scan, ultra detailed surface, sharp focus, 8k",
    "negative": "perspective, vanishing point, tilted, angled view, horizon, sky, single object, centered composition, cast shadow, drop shadow, directional light, specular highlight, glare, reflection, vignette, gradient, uneven lighting, border, frame, watermark, text, letters, signature, logo, blur, depth of field, bokeh, jpeg artifacts, lowres, people, hands, footprints, tyre tracks, cartoon, illustration, painting, pixel art, low poly, 3d render"
  },
  {
    "name": "clay roof tiles",
    "positive": "colormap, seamless tileable texture of overlapping terracotta barrel roof tiles, warm fired clay, lichen spotting, chipped edges, regular rows with slight irregularity, orthographic top-down view, flat lay, full frame surface, edge to edge coverage, even diffuse studio lighting, no shadows, no specular highlights, uniform exposure, physically based albedo, photorealistic material scan, ultra detailed surface, sharp focus, 8k",
    "negative": "perspective, vanishing point, tilted, angled view, horizon, sky, single object, centered composition, cast shadow, drop shadow, directional light, specular highlight, glare, reflection, vignette, gradient, uneven lighting, border, frame, watermark, text, letters, signature, logo, blur, depth of field, bokeh, jpeg artifacts, lowres, people, hands, roof ridge, chimney, gutter, cartoon, illustration, painting, pixel art, low poly, 3d render"
  },
  {
    "name": "granite cliff rock",
    "positive": "colormap, seamless tileable texture of rough grey granite rock face, sharp fracture planes, quartz and feldspar speckle, hairline cracks, fine mineral grain, orthographic top-down view, flat lay, full frame surface, edge to edge coverage, even diffuse studio lighting, no shadows, no specular highlights, uniform exposure, physically based albedo, photorealistic material scan, ultra detailed surface, sharp focus, 8k",
    "negative": "perspective, vanishing point, tilted, angled view, horizon, sky, single object, single boulder, centered composition, cast shadow, drop shadow, directional light, specular highlight, glare, reflection, vignette, gradient, uneven lighting, border, frame, watermark, text, letters, signature, logo, blur, depth of field, bokeh, jpeg artifacts, lowres, people, hands, cartoon, illustration, painting, pixel art, low poly, 3d render"
  },
  {
    "name": "rusted iron plate",
    "positive": "colormap, seamless tileable texture of riveted wrought iron plate, deep orange rust bloom, flaking dark paint remnants, pitted corroded metal, evenly spaced small rivets, orthographic top-down view, flat lay, full frame surface, edge to edge coverage, even diffuse studio lighting, no shadows, no specular highlights, uniform exposure, physically based albedo, photorealistic material scan, ultra detailed surface, sharp focus, 8k",
    "negative": "perspective, vanishing point, tilted, angled view, horizon, sky, single object, centered composition, cast shadow, drop shadow, directional light, specular highlight, glare, reflection, mirror finish, chrome, vignette, gradient, uneven lighting, border, frame, watermark, text, letters, signature, logo, blur, depth of field, bokeh, jpeg artifacts, lowres, people, hands, cartoon, illustration, painting, pixel art, low poly, 3d render"
  },
  {
    "name": "forest floor",
    "positive": "colormap, seamless tileable texture of forest floor leaf litter, fallen beech and oak leaves, small twigs, dark humus soil showing through, scattered acorns, tightly packed small scale, orthographic top-down view, flat lay, full frame surface, edge to edge coverage, even diffuse studio lighting, no shadows, no specular highlights, uniform exposure, physically based albedo, photorealistic material scan, ultra detailed surface, sharp focus, 8k",
    "negative": "perspective, vanishing point, tilted, angled view, horizon, sky, tree trunk, single object, centered composition, cast shadow, drop shadow, dappled light, directional light, specular highlight, glare, reflection, vignette, gradient, uneven lighting, border, frame, watermark, text, letters, signature, logo, blur, depth of field, bokeh, jpeg artifacts, lowres, people, hands, cartoon, illustration, painting, pixel art, low poly, 3d render"
  },
  {
    "name": "beach sand",
    "positive": "colormap, seamless tileable texture of fine wind rippled quartz beach sand, small regular ripple crests, scattered shell fragments, subtle grain sparkle, orthographic top-down view, flat lay, full frame surface, edge to edge coverage, even diffuse studio lighting, no shadows, no specular highlights, uniform exposure, physically based albedo, photorealistic material scan, ultra detailed surface, sharp focus, 8k",
    "negative": "perspective, vanishing point, tilted, angled view, horizon, sky, sea, waves, water, single object, centered composition, cast shadow, drop shadow, directional light, specular highlight, glare, reflection, vignette, gradient, uneven lighting, border, frame, watermark, text, letters, signature, logo, blur, depth of field, bokeh, jpeg artifacts, lowres, people, hands, footprints, cartoon, illustration, painting, pixel art, low poly, 3d render"
  },
  {
    "name": "burlap fabric",
    "positive": "colormap, seamless tileable texture of coarse woven jute burlap sackcloth, visible warp and weft threads, loose frayed fibres, natural undyed fibre colour variation, orthographic top-down view, flat lay, full frame surface, edge to edge coverage, even diffuse studio lighting, no shadows, no specular highlights, uniform exposure, physically based albedo, photorealistic material scan, ultra detailed surface, sharp focus, 8k",
    "negative": "perspective, vanishing point, tilted, angled view, horizon, sky, single object, centered composition, folds, wrinkles, drapery, hem, stitching, cast shadow, drop shadow, directional light, specular highlight, glare, reflection, vignette, gradient, uneven lighting, border, frame, watermark, text, letters, signature, logo, blur, depth of field, bokeh, jpeg artifacts, lowres, people, hands, cartoon, illustration, painting, pixel art, low poly, 3d render"
  },
  {
    "name": "cracked mud",
    "positive": "colormap, seamless tileable texture of sun baked desert clay hardpan, deep polygonal crack network, curled dried mud flakes, pale dusty surface, orthographic top-down view, flat lay, full frame surface, edge to edge coverage, even diffuse studio lighting, no shadows, no specular highlights, uniform exposure, physically based albedo, photorealistic material scan, ultra detailed surface, sharp focus, 8k",
    "negative": "perspective, vanishing point, tilted, angled view, horizon, sky, single object, centered composition, cast shadow, drop shadow, directional light, specular highlight, glare, reflection, vignette, gradient, uneven lighting, border, frame, watermark, text, letters, signature, logo, blur, depth of field, bokeh, jpeg artifacts, lowres, people, hands, water, puddle, plant, cartoon, illustration, painting, pixel art, low poly, 3d render"
  }
]
```
