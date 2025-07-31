import type { Plugin } from 'vite';
import type { OutputBundle, NormalizedOutputOptions } from 'rollup';
import sharp from 'sharp';

export interface WebpOptions {
  quality?: number;
  alphaQuality?: number;
  smartSubsample?: boolean;
}

export interface PngOptions {
  quality?: number;
  compressionLevel?: number;
  palette?: boolean;
  adaptiveFiltering?: boolean;
}

export interface AvifOptions {
  quality?: number;
  lossless?: boolean;
  speed?: number;
}

export interface SingleImageFormatOptions {
  format?: 'webp' | 'png' | 'avif';
  reencode?: boolean;
  webp?: WebpOptions;
  png?: PngOptions;
  avif?: AvifOptions;
}

export default function singleImageFormat(userOpts: SingleImageFormatOptions = {}): Plugin {
  const {
    format = 'webp',
    reencode = false,
    webp: userWebp = {},
    png: userPng = {},
    avif: userAvif = {},
  } = userOpts;

  const defaultWebp: Required<WebpOptions> = {
    quality: 88,
    alphaQuality: 90,
    smartSubsample: true,
  };

  const defaultPng: Required<PngOptions> = {
    quality: 80,
    compressionLevel: 9,
    palette: true,
    adaptiveFiltering: true,
  };

  const defaultAvif: Required<AvifOptions> = {
    quality: 60,
    lossless: false,
    speed: 5,
  };

  const webpOpts: Required<WebpOptions> = { ...defaultWebp, ...userWebp };
  const pngOpts: Required<PngOptions> = { ...defaultPng, ...userPng };
  const avifOpts: Required<AvifOptions> = { ...defaultAvif, ...userAvif };

  const rasterExtRE = /\.(png|jpe?g|webp|gif|avif|heif|heic|tiff?|bmp|jp2)$/i;
  const textExts = ['.html', '.css', '.js', '.mjs', '.ts'];

  return {
    name: 'vite-plugin-single-image-format',
    apply: 'build',
    enforce: 'post',

    async generateBundle(_options: NormalizedOutputOptions, bundle: OutputBundle): Promise<void> {
      const renameMap = new Map<string, string>();

      for (const [fileName, asset] of Object.entries(bundle)) {
        if (asset.type !== 'asset' || !rasterExtRE.test(fileName)) continue;

        const isTargetExt = fileName.toLowerCase().endsWith(`.${format}`);

        if (isTargetExt && !reencode) continue;

        const inputBuffer: Buffer =
          typeof asset.source === 'string' ? Buffer.from(asset.source) : Buffer.from(asset.source);

        const outputBuffer =
          format === 'webp'
            ? await sharp(inputBuffer).webp(webpOpts).toBuffer()
            : format === 'png'
              ? await sharp(inputBuffer).png(pngOpts).toBuffer()
              : await sharp(inputBuffer).avif(avifOpts).toBuffer();

        if (isTargetExt) {
          asset.source = outputBuffer;
          continue;
        }

        const newName = fileName.replace(rasterExtRE, `.${format}`);

        if (bundle[newName]) continue;

        this.emitFile({
          type: 'asset',
          fileName: newName,
          source: outputBuffer,
        });

        renameMap.set(fileName, newName);
        delete bundle[fileName];
      }

      if (renameMap.size === 0) return;

      for (const asset of Object.values(bundle)) {
        if (asset.type !== 'asset') continue;
        if (!textExts.some((ext) => asset.fileName.endsWith(ext))) continue;

        let code = asset.source.toString();

        for (const [oldName, newName] of renameMap) {
          const escaped = oldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

          code = code.replace(new RegExp(`([./]*)${escaped}`, 'g'), (_m, p1) => `${p1}${newName}`);
        }

        asset.source = code;
      }
    },
  };
}
