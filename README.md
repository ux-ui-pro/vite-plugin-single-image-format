<div align="center">
<br>

<h1>vite-plugin-single-image-format</h1>

**vite-plugin-single-image-format** is a Vite/Rollup plugin that converts **every raster asset** in your build to **a single output format** – `webp`, `png` **or** `avif`.
It can optionally re-compress images that are already in the target format and automatically rewrites all references in HTML/CSS/JS. It can also add or correct intrinsic `width`/`height` on `<img>` tags in generated HTML.

[![npm](https://img.shields.io/npm/v/vite-plugin-single-image-format.svg?colorB=brightgreen)](https://www.npmjs.com/package/vite-plugin-single-image-format)
[![GitHub package version](https://img.shields.io/github/package-json/v/ux-ui-pro/vite-plugin-single-image-format.svg)](https://github.com/ux-ui-pro/vite-plugin-single-image-format)
[![NPM Downloads](https://img.shields.io/npm/dm/vite-plugin-single-image-format.svg?style=flat)](https://www.npmjs.org/package/vite-plugin-single-image-format)
</div>
<br>


➠ **Install**

```bash
# yarn
yarn add -D vite-plugin-single-image-format

# pnpm
pnpm add -D vite-plugin-single-image-format

# npm
npm i -D vite-plugin-single-image-format
```

<br>


➠ **Quick Start**

```ts
// vite.config.ts
import { defineConfig } from 'vite';
import singleImageFormat from 'vite-plugin-single-image-format';

export default defineConfig({
  plugins: [
    singleImageFormat({
      format: 'avif',           // 'webp' | 'png' | 'avif' (default: 'webp')
      reencode: true,           // also re-compress files already in the target format
      htmlSizeMode: 'add-only', // 'off' | 'add-only' | 'overwrite' (default: 'add-only')
      avif: {
        quality: 60,
        speed: 5
      },
    }),
  ],
});
```

<br>


➠ **Options**

|     Field      |                                 Type                                 |   Default    | Description                                                               |
|:--------------:|:--------------------------------------------------------------------:|:------------:|:--------------------------------------------------------------------------|
|    `format`    |               `'webp'` &#124; `'png'` &#124; `'avif'`                |   `'webp'`   | Output image format after build.                                          |
|   `reencode`   |                              `boolean`                               |   `false`    | Re-compress files already in the target format.                           |
| `htmlSizeMode` |           `'off'` &#124; `'add-only'` &#124; `'overwrite'`           | `'add-only'` | Controls writing intrinsic `width`/`height` to `<img>` in generated HTML. |
|     `webp`     | [Sharp WebpOptions](https://sharp.pixelplumbing.com/api-output#webp) | see defaults | Options forwarded to `sharp().webp()`.                                    |
|     `png`      |  [Sharp PngOptions](https://sharp.pixelplumbing.com/api-output#png)  | see defaults | Options forwarded to `sharp().png()`.                                     |
|     `avif`     | [Sharp AvifOptions](https://sharp.pixelplumbing.com/api-output#avif) | see defaults | Options forwarded to `sharp().avif()`.                                    |

<br>


➠ **Default `webp` options**

|      Option      | Default | Description                    |
|:----------------:|:-------:|:-------------------------------|
|    `quality`     |  `88`   | RGB quality (1-100).           |
|  `alphaQuality`  |  `90`   | Alpha channel quality (0-100). |
| `smartSubsample` | `true`  | Enable smart subsampling.      |

<br>


➠ **Default `png` options**

|       Option        | Default | Description                                                        |
|:-------------------:|:-------:|:-------------------------------------------------------------------|
|      `quality`      |  `80`   | Palette quantisation quality (1-100) – used when `palette = true`. |
| `compressionLevel`  |   `9`   | Deflate compression level (0-9).                                   |
|      `palette`      | `true`  | Generate an 8-bit indexed palette.                                 |
| `adaptiveFiltering` | `true`  | Enable adaptive filtering.                                         |

<br>


➠ **Default `avif` options**

|   Option   | Default | Description                                             |
|:----------:|:-------:|:--------------------------------------------------------|
| `quality`  |  `60`   | Visual quality (0-100).                                 |
| `lossless` | `false` | Produce lossless output.                                |
|  `speed`   |   `5`   | CPU/bandwidth trade-off (0-10, lower is slower/better). |

<br>


➠ **Local opt-out: `?imgfmt=keep`**

You can prevent conversion/renaming **per image** by appending a query flag to its reference. The asset will pass through **unchanged**, but dimensions will still be collected (when possible) for HTML sizing.

```html
<!-- stays in original format -->
<img src="/src/assets/brand.png?imgfmt=keep" alt="Brand">
```

**How matching works**

During `resolveId/transform`, references with `?imgfmt=keep` are **recorded**.

> Tip: You can use the flag in imports, templates, or HTML — anywhere the path is visible to Vite’s pipeline.

<br>


➠ **Supported input formats**

```
png, jpg/jpeg, webp, gif, avif, heif/heic, tiff, bmp, jp2
```
> Note: **AVIF/HEIF/JP2** require a libvips build with the respective decoders. Encoding **AVIF** requires libvips compiled with AVIF encoder support.

<br>


➠ **License**

MIT
