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

export type HtmlSizeMode = 'off' | 'add-only' | 'overwrite';

export interface SingleImageFormatOptions {
  format?: 'webp' | 'png' | 'avif';
  reencode?: boolean;
  webp?: WebpOptions;
  png?: PngOptions;
  avif?: AvifOptions;
  htmlSizeMode?: HtmlSizeMode;
}

export default function singleImageFormat(userOpts: SingleImageFormatOptions = {}): Plugin {
  const {
    format = 'webp',
    reencode = false,
    webp: userWebp = {},
    png: userPng = {},
    avif: userAvif = {},
    htmlSizeMode = 'add-only',
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
  const textExts = ['.html', '.css', '.js', '.mjs', '.ts', '.jsx', '.tsx'];
  const KEEP_FLAG = 'imgfmt=keep';

  const dimensionMap = new Map<string, { width: number; height: number }>();

  function hasAttr(str: string, attr: 'width' | 'height'): boolean {
    const re = new RegExp(`\\b${attr}\\s*=`, 'i');

    return re.test(str);
  }

  function stripSizeAttrs(str: string): string {
    return str.replace(/\s+(?:width|height)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  }

  function normalizeSrcForMatch(src: string): string {
    return src.split(/[?#]/)[0];
  }

  function matchFinalName(src: string): string | null {
    const cleaned = normalizeSrcForMatch(src);

    for (const finalName of dimensionMap.keys()) {
      if (
        cleaned.endsWith(finalName) ||
        cleaned.endsWith('./' + finalName) ||
        cleaned.endsWith('/' + finalName)
      ) {
        return finalName;
      }
    }

    return null;
  }

  function rebuildImgTag(
    full: string,
    preAttrs: string,
    quote: '"' | "'",
    src: string,
    postAttrs: string,
    selfClose: string,
  ): string {
    const finalName = matchFinalName(src);

    if (!finalName) return full;

    const dims = dimensionMap.get(finalName);

    if (!dims) return full;

    if (htmlSizeMode === 'overwrite') {
      const newPre = stripSizeAttrs(preAttrs);
      const newPost = stripSizeAttrs(postAttrs);

      return `<img ${newPre}src=${quote}${src}${quote}${newPost} width="${dims.width}" height="${dims.height}"${selfClose}>`;
    }

    const hasW = hasAttr(preAttrs + postAttrs, 'width');
    const hasH = hasAttr(preAttrs + postAttrs, 'height');

    if (hasW && hasH) return full;

    const extraW = hasW ? '' : ` width="${dims.width}"`;
    const extraH = hasH ? '' : ` height="${dims.height}"`;

    return `<img ${preAttrs}src=${quote}${src}${quote}${postAttrs}${extraW}${extraH}${selfClose}>`;
  }

  function escapeRe(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function stripKeepFromQuery(qsAndHash: string): string {
    const [qsPartRaw, hashPart = ''] = qsAndHash.split('#', 2);
    const hasQ = qsPartRaw.startsWith('?');
    const qsPart = hasQ ? qsPartRaw.slice(1) : qsPartRaw;

    if (!qsPart) {
      return (hasQ ? '?' : '') + (hashPart ? '#' + hashPart : '');
    }

    const keptParams = qsPart
      .split('&')
      .filter(Boolean)
      .filter((p) => {
        const [k, v = ''] = p.split('=', 2);
        return !(k === 'imgfmt' && v === 'keep');
      });

    const rebuilt = keptParams.length ? '?' + keptParams.join('&') : '';

    return rebuilt + (hashPart ? '#' + hashPart : '');
  }

  return {
    name: 'vite-plugin-single-image-format',
    apply: 'build',
    enforce: 'post',

    async generateBundle(_options: NormalizedOutputOptions, bundle: OutputBundle): Promise<void> {
      const renameMap = new Map<string, string>();
      const keepSet = new Set<string>();

      const textPayloads: string[] = [];

      for (const asset of Object.values(bundle)) {
        if (asset.type !== 'asset') continue;
        if (!textExts.some((ext) => asset.fileName.endsWith(ext))) continue;

        textPayloads.push(asset.source.toString());
      }

      if (textPayloads.length > 0) {
        for (const [fileName, asset] of Object.entries(bundle)) {
          if (asset.type !== 'asset' || !rasterExtRE.test(fileName)) continue;

          const needle = `${fileName}?${KEEP_FLAG}`;

          if (textPayloads.some((txt) => txt.includes(needle))) {
            keepSet.add(fileName);
          }
        }
      }

      for (const [fileName, asset] of Object.entries(bundle)) {
        if (asset.type !== 'asset' || !rasterExtRE.test(fileName)) continue;

        const inputBuffer: Buffer =
          typeof asset.source === 'string' ? Buffer.from(asset.source) : Buffer.from(asset.source);

        if (keepSet.has(fileName)) {
          try {
            const meta = await sharp(inputBuffer).metadata();

            if (meta.width && meta.height) {
              dimensionMap.set(fileName, { width: meta.width, height: meta.height });
            }
          } catch (err) {
            if (process?.env?.NODE_ENV === 'development') {
              console.debug('[singleImageFormat] metadata probe failed (keep)', err);
            }
          }

          continue;
        }

        const isTargetExt = fileName.toLowerCase().endsWith(`.${format}`);

        if (isTargetExt && !reencode) {
          try {
            const meta = await sharp(inputBuffer).metadata();

            if (meta.width && meta.height) {
              dimensionMap.set(fileName, { width: meta.width, height: meta.height });
            }
          } catch (err) {
            if (process?.env?.NODE_ENV === 'development') {
              console.debug('[singleImageFormat] metadata probe failed (passthrough)', err);
            }
          }

          continue;
        }

        const outputBuffer =
          format === 'webp'
            ? await sharp(inputBuffer).webp(webpOpts).toBuffer()
            : format === 'png'
              ? await sharp(inputBuffer).png(pngOpts).toBuffer()
              : await sharp(inputBuffer).avif(avifOpts).toBuffer();

        const outMeta = await sharp(outputBuffer).metadata();
        const size =
          outMeta.width && outMeta.height
            ? { width: outMeta.width, height: outMeta.height }
            : undefined;

        if (isTargetExt) {
          asset.source = outputBuffer;

          if (size) dimensionMap.set(fileName, size);

          continue;
        }

        const newName = fileName.replace(rasterExtRE, `.${format}`);

        if (bundle[newName]) {
          if (size) dimensionMap.set(fileName, size);

          asset.source = outputBuffer;

          continue;
        }

        this.emitFile({ type: 'asset', fileName: newName, source: outputBuffer });

        renameMap.set(fileName, newName);

        if (size) dimensionMap.set(newName, size);

        delete bundle[fileName];
      }

      if (renameMap.size > 0) {
        for (const asset of Object.values(bundle)) {
          if (asset.type !== 'asset') continue;
          if (!textExts.some((ext) => asset.fileName.endsWith(ext))) continue;

          let code = asset.source.toString();

          for (const [oldName, newName] of renameMap) {
            const escaped = oldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

            code = code.replace(
              new RegExp(`([./]*)${escaped}`, 'g'),
              (_m: string, p1: string) => `${p1}${newName}`,
            );
          }

          asset.source = code;
        }
      }

      {
        const keepList = Array.from(keepSet);

        if (keepList.length > 0) {
          for (const asset of Object.values(bundle)) {
            if (asset.type !== 'asset') continue;
            if (!textExts.some((ext) => asset.fileName.endsWith(ext))) continue;

            let code = asset.source.toString();

            for (const fileName of keepList) {
              const re = new RegExp(
                `(${escapeRe(fileName)})(\\?[^"'\\s)><#]*?)?(#[^"'\\s)><]*)?`,
                'g',
              );

              code = code.replace(
                re,
                (_m: string, fname: string, qPart?: string, hashPart?: string) => {
                  if (!qPart) return fname + (hashPart ?? '');

                  const cleaned = stripKeepFromQuery((qPart || '') + (hashPart || ''));

                  return fname + cleaned;
                },
              );

              const simple = new RegExp(
                `(${escapeRe(fileName)})\\?${KEEP_FLAG}(?![^"'\\s)><#])`,
                'g',
              );
              code = code.replace(simple, '$1');
            }

            asset.source = code;
          }
        }
      }

      if (htmlSizeMode !== 'off' && dimensionMap.size > 0) {
        for (const asset of Object.values(bundle)) {
          if (asset.type !== 'asset') continue;
          if (!asset.fileName.endsWith('.html')) continue;

          const html = asset.source.toString();
          const imgTagRE = /<img\s+([^>]*?)src=(["'])([^"']+)\2([^>]*?)(\/?)>/gi;

          const newHtml = html.replace(
            imgTagRE,
            (
              full: string,
              preAttrs: string,
              quote: '"' | "'",
              src: string,
              postAttrs: string,
              selfClose: string,
            ): string => rebuildImgTag(full, preAttrs, quote, src, postAttrs, selfClose),
          );

          asset.source = newHtml;
        }
      }
    },
  };
}
