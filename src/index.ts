import { createHash } from 'node:crypto';
import { posix as pathPosix } from 'node:path';
import remapping, {
  type SourceMapInput as RemappingSourceMapInput,
  type SourceMapLoader as RemappingSourceMapLoader,
} from '@ampproject/remapping';
import MagicString from 'magic-string';
import pLimit from 'p-limit';
import type { NormalizedOutputOptions, OutputBundle, SourceMap as RollupSourceMap } from 'rollup';
import sharp from 'sharp';
import type { Plugin } from 'vite';

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
  hashInName?: boolean;
  hashLength?: number;
  maxConcurrent?: number;
  sharpConcurrency?: number;
}

export default function singleImageFormat(userOpts: SingleImageFormatOptions = {}): Plugin {
  const {
    format = 'webp',
    reencode = false,
    webp: userWebp = {},
    png: userPng = {},
    avif: userAvif = {},
    htmlSizeMode = 'add-only',
    hashInName = false,
    hashLength = 8,

    maxConcurrent = 2,
    sharpConcurrency,
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

  type TextRef = { fileName: string; code: string };

  function isTextLikeAssetFileName(fileName: string): boolean {
    return textExts.some((ext) => fileName.endsWith(ext));
  }

  function isChunkFileName(fileName: string): boolean {
    return fileName.endsWith('.js') || fileName.endsWith('.mjs') || fileName.endsWith('.cjs');
  }

  function collectTextRefs(bundle: OutputBundle): TextRef[] {
    const refs: TextRef[] = [];

    for (const item of Object.values(bundle)) {
      if (item.type === 'asset') {
        if (!isTextLikeAssetFileName(item.fileName)) continue;
        refs.push({ fileName: item.fileName, code: item.source.toString() });
        continue;
      }

      if (item.type === 'chunk') {
        if (!isChunkFileName(item.fileName)) continue;
        refs.push({ fileName: item.fileName, code: item.code });
      }
    }

    return refs;
  }

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
        cleaned.endsWith(`./${finalName}`) ||
        cleaned.endsWith(`/${finalName}`)
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
      return (hasQ ? '?' : '') + (hashPart ? `#${hashPart}` : '');
    }

    const keptParams = qsPart
      .split('&')
      .filter(Boolean)
      .filter((p) => {
        const [k, v = ''] = p.split('=', 2);
        return !(k === 'imgfmt' && v === 'keep');
      });

    const rebuilt = keptParams.length ? `?${keptParams.join('&')}` : '';
    return rebuilt + (hashPart ? `#${hashPart}` : '');
  }

  function applyRenameMapToString(
    code: string,
    fromDir: string,
    renameMap: Map<string, string>,
  ): string {
    let next = code;

    for (const [oldName, newName] of renameMap) {
      const oldRel = pathPosix.relative(fromDir, oldName);
      const newRel = pathPosix.relative(fromDir, newName);

      const variantPairs: Array<[string, string]> = [
        [oldName, newName],
        [oldRel, newRel],
      ];

      if (!oldRel.startsWith('.') && !oldRel.startsWith('/')) {
        variantPairs.push([`./${oldRel}`, `./${newRel}`]);
      }

      for (const [fromPath, toPath] of variantPairs) {
        const re = new RegExp(`(${escapeRe(fromPath)})(\\?[^"'\\s)><#]*?)?(#[^"'\\s)><]*)?`, 'g');

        next = next.replace(
          re,
          (_m: string, _p: string, qPart?: string, hashPart?: string) =>
            `${toPath}${qPart ?? ''}${hashPart ?? ''}`,
        );
      }
    }

    return next;
  }

  function applyKeepStripToString(code: string, fromDir: string, keepList: string[]): string {
    let next = code;

    for (const fileName of keepList) {
      const rel = pathPosix.relative(fromDir, fileName);
      const candidates = new Set<string>();

      candidates.add(fileName);
      candidates.add(rel);

      if (!rel.startsWith('.') && !rel.startsWith('/')) {
        candidates.add(`./${rel}`);
      }

      for (const cand of candidates) {
        const re = new RegExp(`(${escapeRe(cand)})(\\?[^"'\\s)><#]*?)?(#[^"'\\s)><]*)?`, 'g');

        next = next.replace(re, (_m: string, fname: string, qPart?: string, hashPart?: string) => {
          if (!qPart) return fname + (hashPart ?? '');
          const cleaned = stripKeepFromQuery((qPart || '') + (hashPart || ''));
          return fname + cleaned;
        });

        const simple = new RegExp(`(${escapeRe(cand)})\\?${KEEP_FLAG}(?![^"'\\s)><#])`, 'g');
        next = next.replace(simple, '$1');
      }
    }

    return next;
  }

  function applyRenameMapToMagicString(
    ms: MagicString,
    originalCode: string,
    fromDir: string,
    renameMap: Map<string, string>,
  ): void {
    for (const [oldName, newName] of renameMap) {
      const oldRel = pathPosix.relative(fromDir, oldName);
      const newRel = pathPosix.relative(fromDir, newName);

      const variantPairs: Array<[string, string]> = [
        [oldName, newName],
        [oldRel, newRel],
      ];

      if (!oldRel.startsWith('.') && !oldRel.startsWith('/')) {
        variantPairs.push([`./${oldRel}`, `./${newRel}`]);
      }

      for (const [fromPath, toPath] of variantPairs) {
        const re = new RegExp(`(${escapeRe(fromPath)})(\\?[^"'\\s)><#]*?)?(#[^"'\\s)><]*)?`, 'g');

        let m = re.exec(originalCode);
        while (m !== null) {
          const qPart = m[2] ?? '';
          const hashPart = m[3] ?? '';
          const replacement = `${toPath}${qPart}${hashPart}`;
          ms.overwrite(m.index, m.index + m[0].length, replacement);
          m = re.exec(originalCode);
        }
      }
    }
  }

  function applyKeepStripToMagicString(
    ms: MagicString,
    originalCode: string,
    fromDir: string,
    keepList: string[],
  ): void {
    for (const fileName of keepList) {
      const rel = pathPosix.relative(fromDir, fileName);
      const candidates = new Set<string>();

      candidates.add(fileName);
      candidates.add(rel);

      if (!rel.startsWith('.') && !rel.startsWith('/')) {
        candidates.add(`./${rel}`);
      }

      for (const cand of candidates) {
        const re = new RegExp(`(${escapeRe(cand)})(\\?[^"'\\s)><#]*?)?(#[^"'\\s)><]*)?`, 'g');

        let m = re.exec(originalCode);
        while (m !== null) {
          const fname = m[1] ?? '';
          const qPart = m[2] ?? '';
          const hashPart = m[3] ?? '';

          if (!qPart) continue;

          const cleaned = stripKeepFromQuery(qPart + hashPart);
          const replacement = fname + cleaned;

          ms.overwrite(m.index, m.index + m[0].length, replacement);
          m = re.exec(originalCode);
        }

        const simple = new RegExp(`(${escapeRe(cand)})\\?${KEEP_FLAG}(?![^"'\\s)><#])`, 'g');
        m = simple.exec(originalCode);
        while (m !== null) {
          ms.overwrite(m.index, m.index + m[0].length, m[1] ?? '');
          m = simple.exec(originalCode);
        }
      }
    }
  }

  function hasGenericAttr(str: string, attrName: string): boolean {
    const re = new RegExp(`\\b${attrName}\\s*=`, 'i');
    return re.test(str);
  }

  function stripNamedAttr(str: string, attrName: string): string {
    const re = new RegExp(String.raw`(^|\s+)${attrName}\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)`, 'gi');
    return str.replace(re, '$1');
  }

  function extToMime(ext: string): string | null {
    const e = ext.toLowerCase();

    if (e === 'webp') return 'image/webp';
    if (e === 'png') return 'image/png';
    if (e === 'avif') return 'image/avif';
    if (e === 'jpg' || e === 'jpeg') return 'image/jpeg';
    if (e === 'gif') return 'image/gif';
    if (e === 'svg') return 'image/svg+xml';
    if (e === 'bmp') return 'image/bmp';
    if (e === 'tif' || e === 'tiff') return 'image/tiff';
    if (e === 'heif') return 'image/heif';
    if (e === 'heic') return 'image/heic';
    if (e === 'jp2') return 'image/jp2';

    return null;
  }

  function pickMimeFromSrcset(srcset: string): string | null {
    const entries = srcset
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    for (const entry of entries) {
      const urlPart = entry.split(/\s+/)[0] || '';
      const cleaned = urlPart.split(/[?#]/)[0];
      const m = cleaned.match(/\.([a-z0-9]+)$/i);

      if (m?.[1]) {
        const mime = extToMime(m[1]);
        if (mime) return mime;
      }
    }

    return null;
  }

  function computeContentHash(buffer: Buffer, length: number): string {
    const full = createHash('sha256').update(buffer).digest('hex');
    const len = Math.max(1, Math.min(length, full.length));
    return full.slice(0, len);
  }

  function addHashToFileName(fileName: string, hash: string, delimiter = '-'): string {
    const parsed = pathPosix.parse(fileName);
    const base = `${parsed.name}${delimiter}${hash}${parsed.ext}`;
    return parsed.dir ? `${parsed.dir}/${base}` : base;
  }

  function clampInt(n: unknown, fallback: number): number {
    if (typeof n !== 'number' || !Number.isFinite(n)) return fallback;
    return Math.max(1, Math.floor(n));
  }

  const limit = pLimit(clampInt(maxConcurrent, 2));
  let sharpConcurrencyApplied = false;

  async function probeInputSize(
    inputBuffer: Buffer,
    debugTag: string,
  ): Promise<{ width: number; height: number } | undefined> {
    try {
      const meta = await limit(() => sharp(inputBuffer).metadata());
      if (meta.width && meta.height) return { width: meta.width, height: meta.height };
      return undefined;
    } catch (err) {
      if (process?.env?.NODE_ENV === 'development') {
        console.debug(`[singleImageFormat] metadata probe failed (${debugTag})`, err);
      }
      return undefined;
    }
  }

  async function encodeToTarget(inputBuffer: Buffer): Promise<Buffer> {
    return limit(async () => {
      const s = sharp(inputBuffer);
      if (format === 'webp') return s.webp(webpOpts).toBuffer();
      if (format === 'png') return s.png(pngOpts).toBuffer();
      return s.avif(avifOpts).toBuffer();
    });
  }

  return {
    name: 'vite-plugin-single-image-format',
    apply: 'build',
    enforce: 'post',

    configResolved() {
      if (sharpConcurrencyApplied) return;
      if (typeof sharpConcurrency === 'number') {
        sharp.concurrency(clampInt(sharpConcurrency, 1));
      }
      sharpConcurrencyApplied = true;
    },

    async generateBundle(_options: NormalizedOutputOptions, bundle: OutputBundle): Promise<void> {
      const renameMap = new Map<string, string>();
      const keepSet = new Set<string>();

      const textRefs = collectTextRefs(bundle);

      if (textRefs.length > 0) {
        for (const [rasterName, asset] of Object.entries(bundle)) {
          if (asset.type !== 'asset' || !rasterExtRE.test(rasterName)) continue;

          let shouldKeep = false;

          for (const ta of textRefs) {
            const fromDir = pathPosix.dirname(ta.fileName);
            const rel = pathPosix.relative(fromDir, rasterName);

            const candidates = new Set<string>();
            candidates.add(rasterName);
            candidates.add(rel);

            if (!rel.startsWith('.') && !rel.startsWith('/')) {
              candidates.add(`./${rel}`);
            }

            for (const cand of candidates) {
              const needle = `${cand}?${KEEP_FLAG}`;
              if (ta.code.includes(needle)) {
                shouldKeep = true;
                break;
              }
            }

            if (shouldKeep) break;
          }

          if (shouldKeep) keepSet.add(rasterName);
        }
      }

      for (const [fileName, asset] of Object.entries(bundle)) {
        if (asset.type !== 'asset' || !rasterExtRE.test(fileName)) continue;

        const inputBuffer: Buffer =
          typeof asset.source === 'string' ? Buffer.from(asset.source) : Buffer.from(asset.source);

        const inputSize = await probeInputSize(
          inputBuffer,
          keepSet.has(fileName) ? 'keep' : 'input',
        );

        if (keepSet.has(fileName)) {
          if (inputSize) dimensionMap.set(fileName, inputSize);
          continue;
        }

        const isTargetExt = fileName.toLowerCase().endsWith(`.${format}`);

        if (isTargetExt && !reencode) {
          if (!hashInName) {
            if (inputSize) dimensionMap.set(fileName, inputSize);
            continue;
          }

          const hash = computeContentHash(inputBuffer, hashLength);
          const hashedName = addHashToFileName(fileName, hash);

          if (bundle[hashedName]) {
            if (inputSize) dimensionMap.set(fileName, inputSize);
            continue;
          }

          this.emitFile({ type: 'asset', fileName: hashedName, source: inputBuffer });
          renameMap.set(fileName, hashedName);

          if (inputSize) dimensionMap.set(hashedName, inputSize);
          delete bundle[fileName];
          continue;
        }

        const outputBuffer = await encodeToTarget(inputBuffer);

        if (isTargetExt) {
          asset.source = outputBuffer;
          if (inputSize) dimensionMap.set(fileName, inputSize);
          continue;
        }

        const targetName = fileName.replace(rasterExtRE, `.${format}`);
        const newName = hashInName
          ? addHashToFileName(targetName, computeContentHash(outputBuffer, hashLength))
          : targetName;

        if (bundle[newName]) {
          asset.source = outputBuffer;
          if (inputSize) dimensionMap.set(fileName, inputSize);
          continue;
        }

        this.emitFile({ type: 'asset', fileName: newName, source: outputBuffer });
        renameMap.set(fileName, newName);

        if (inputSize) dimensionMap.set(newName, inputSize);
        delete bundle[fileName];
      }

      const keepList = Array.from(keepSet);

      if (renameMap.size > 0 || keepList.length > 0) {
        for (const item of Object.values(bundle)) {
          if (item.type === 'asset') {
            if (!isTextLikeAssetFileName(item.fileName)) continue;

            const fromDir = pathPosix.dirname(item.fileName);
            let code = item.source.toString();

            if (renameMap.size > 0) code = applyRenameMapToString(code, fromDir, renameMap);
            if (keepList.length > 0) code = applyKeepStripToString(code, fromDir, keepList);

            item.source = code;
            continue;
          }

          if (item.type === 'chunk') {
            if (!isChunkFileName(item.fileName)) continue;

            const fromDir = pathPosix.dirname(item.fileName);
            const originalCode = item.code;
            const ms = new MagicString(originalCode);

            if (renameMap.size > 0)
              applyRenameMapToMagicString(ms, originalCode, fromDir, renameMap);
            if (keepList.length > 0)
              applyKeepStripToMagicString(ms, originalCode, fromDir, keepList);

            if (!ms.hasChanged()) continue;

            item.code = ms.toString();

            if (item.map) {
              const editMap = ms.generateMap({
                hires: true,
                file: item.fileName,
                source: item.fileName,
                includeContent: true,
              });

              const prevMap = item.map as unknown as RemappingSourceMapInput;
              const editInput = editMap as unknown as RemappingSourceMapInput;
              const loader: RemappingSourceMapLoader = (source: string) =>
                source === item.fileName ? prevMap : null;

              const combined = remapping(editInput, loader, true);
              item.map = combined as unknown as RollupSourceMap;
            }
          }
        }
      }

      for (const asset of Object.values(bundle)) {
        if (asset.type !== 'asset') continue;
        if (!asset.fileName.endsWith('.html')) continue;

        const html = asset.source.toString();
        const sourceTagRE = /<source\s+([^>]*?)srcset=(["'])([^"']+)\2([^>]*?)(\/?)>/gi;

        const newHtml = html.replace(
          sourceTagRE,
          (
            full: string,
            preAttrs: string,
            quote: '"' | "'",
            srcset: string,
            postAttrs: string,
            selfClose: string,
          ): string => {
            const desiredMime = pickMimeFromSrcset(srcset);
            if (!desiredMime) return full;

            const hasType = hasGenericAttr(preAttrs + postAttrs, 'type');

            if (hasType) {
              const newPre = stripNamedAttr(preAttrs, 'type');
              const newPost = stripNamedAttr(postAttrs, 'type');
              return `<source ${newPre}srcset=${quote}${srcset}${quote}${newPost} type="${desiredMime}"${selfClose}>`;
            }

            return `<source ${preAttrs}srcset=${quote}${srcset}${quote}${postAttrs} type="${desiredMime}"${selfClose}>`;
          },
        );

        asset.source = newHtml;
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
