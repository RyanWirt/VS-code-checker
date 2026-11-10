import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as yauzl from 'yauzl';
import { SaxesParser } from 'saxes';
import { Worker } from 'node:worker_threads';

export class SafeError extends Error {}
export const MAX_TOTAL_BYTES = 20 * 1024 * 1024;
export const MAX_TEXT_BYTES = 2 * 1024 * 1024;
export const MAX_INPUTS = 200;
export type Role = 'requirements' | 'checklist' | 'artifact';
export interface Selection { path: string; role: Role; label?: string }
export interface Input { id: string; name: string; role: Role; content: string | object }
export interface Config {
  baseUrl: string;
  model: string;
  maxFileSizeMB: number;
  allowedExtensions: string[];
  requestTimeoutSeconds: number;
  caCertPath?: string;
}

export function validateConfig(config: Config): Config {
  let url: URL;
  try { url = new URL(config.baseUrl); } catch { throw new SafeError('Invalid API base URL.'); }
  const loopback = ['127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
      url.username || url.password || url.search || url.hash) {
    throw new SafeError('Use HTTPS (or numeric loopback HTTP) without credentials, query, or fragment.');
  }
  if (!config.model || config.model.length > 200 || /[\u0000-\u001f]/u.test(config.model) ||
      !Number.isFinite(config.maxFileSizeMB) || config.maxFileSizeMB < 0.01 || config.maxFileSizeMB > 20 ||
      !Number.isFinite(config.requestTimeoutSeconds) || config.requestTimeoutSeconds < 1 ||
      config.requestTimeoutSeconds > 600 || !Array.isArray(config.allowedExtensions) ||
      config.allowedExtensions.length > 100 || !config.allowedExtensions.length ||
      config.allowedExtensions.some(ext => typeof ext !== 'string' || !/^\.[a-z0-9]{1,16}$/u.test(ext))) {
    throw new SafeError('Invalid model, size, timeout, or extension configuration.');
  }
  if (config.caCertPath) { validatePath(config.caCertPath); }
  return { ...config, baseUrl: url.href.replace(/\/$/u, '') };
}

export function validatePath(filePath: string): void {
  if (!path.isAbsolute(filePath) || filePath.includes('\0') ||
      filePath.split(/[\\/]/u).some(part => part === '..') ||
      (process.platform !== 'win32' && filePath.includes('\\')) ||
      (process.platform === 'win32' && (filePath.startsWith('\\\\') || filePath.slice(2).includes(':')))) {
    throw new SafeError('Only absolute local paths without traversal are permitted.');
  }
}

export async function assertNoSymlinks(filePath: string): Promise<void> {
  validatePath(filePath);
  let current = path.parse(filePath).root;
  for (const component of filePath.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    if ((await fs.lstat(current)).isSymbolicLink()) {
      throw new SafeError('Symbolic-link paths are not permitted.');
    }
  }
}

function decodeText(data: Uint8Array): string {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(data);
    if (text.includes('\0')) { throw new Error(); }
    return text;
  } catch { throw new SafeError('Text inputs must be valid UTF-8 without binary content.'); }
}

function docxText(data: Buffer): Promise<string> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(data, { lazyEntries: true, validateEntrySizes: true }, (error, zip) => {
      if (error || !zip) { reject(new SafeError('Invalid DOCX archive.')); return; }
      let entries = 0;
      let expanded = 0;
      let document: Buffer | undefined;
      const fail = () => { zip.close(); reject(new SafeError('Invalid or oversized DOCX archive.')); };
      zip.on('error', fail);
      zip.on('entry', (entry: yauzl.Entry) => {
        expanded += entry.uncompressedSize;
        if (++entries > 1000 || expanded > MAX_TOTAL_BYTES ||
            entry.uncompressedSize > MAX_TEXT_BYTES || (entry.generalPurposeBitFlag & 1)) {
          fail(); return;
        }
        if (entry.fileName !== 'word/document.xml') { zip.readEntry(); return; }
        if (document) { fail(); return; }
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) { fail(); return; }
          const chunks: Buffer[] = [];
          let size = 0;
          stream.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAX_TEXT_BYTES) { stream.destroy(); fail(); }
            else { chunks.push(chunk); }
          });
          stream.on('error', fail);
          stream.on('end', () => { document = Buffer.concat(chunks); zip.readEntry(); });
        });
      });
      zip.on('end', () => {
        try {
          if (!document) { throw new Error(); }
          const parser = new SaxesParser({ xmlns: true });
          let text = '';
          let inText = false;
          const wordNamespaces = new Set([
            'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
            'http://purl.oclc.org/ooxml/wordprocessingml/main'
          ]);
          parser.on('doctype', () => { throw new Error(); });
          parser.on('opentag', tag => {
            if (!wordNamespaces.has(tag.uri)) { return; }
            if (tag.local === 't') { inText = true; }
            if (tag.local === 'tab') { text += '\t'; }
            if (tag.local === 'br') { text += '\n'; }
          });
          parser.on('text', value => { if (inText) { text += value; } });
          parser.on('closetag', tag => {
            if (!wordNamespaces.has(tag.uri)) { return; }
            if (tag.local === 't') { inText = false; }
            if (tag.local === 'p') { text += '\n'; }
          });
          parser.write(decodeText(document)).close();
          resolve(text);
        } catch { reject(new SafeError('DOCX document XML could not be extracted safely.')); }
      });
      zip.readEntry();
    });
  });
}

async function pdfText(data: Buffer): Promise<string> {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = getDocument({
    data: new Uint8Array(data), useSystemFonts: false, enableXfa: false,
    disableFontFace: true, verbosity: 0, maxImageSize: 0,
    isOffscreenCanvasSupported: false, isImageDecoderSupported: false,
    useWasm: false, useWorkerFetch: false
  });
  try {
    const doc = await task.promise;
    if (doc.numPages > 200) { throw new SafeError('PDF exceeds the 200-page limit.'); }
    let text = '';
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
      const page = await doc.getPage(pageNumber);
      const content = await page.getTextContent();
      text += content.items.map(item => 'str' in item ? item.str : '').join(' ') + '\n';
      page.cleanup();
      if (Buffer.byteLength(text) > MAX_TEXT_BYTES) { throw new SafeError('Extracted PDF is too large.'); }
    }
    return text;
  } catch { throw new SafeError('PDF could not be extracted within the supported limits.'); }
  finally { await task.destroy(); }
}

export async function extractContent(data: Uint8Array, extension: string): Promise<string> {
  return extension === '.pdf' ? pdfText(Buffer.from(data)) : docxText(Buffer.from(data));
}

function extractInWorker(data: Buffer, extension: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, 'extractor.js'), {
      workerData: { data, extension }, stdout: true, stderr: true,
      resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 }
    });
    // Parser diagnostics may contain document information; never forward them.
    worker.stdout.resume();
    worker.stderr.resume();
    const timer = setTimeout(() => {
      void worker.terminate();
      reject(new SafeError('Document extraction exceeded the 15-second limit.'));
    }, 15_000);
    worker.once('message', (message: unknown) => {
      clearTimeout(timer);
      void worker.terminate();
      if (typeof message !== 'string' || Buffer.byteLength(message) > MAX_TEXT_BYTES) {
        reject(new SafeError('Document extraction failed or exceeded its supported limits.'));
      } else { resolve(message); }
    });
    worker.once('error', () => {
      clearTimeout(timer);
      reject(new SafeError('Document extraction failed safely.'));
    });
    worker.once('exit', () => {
      clearTimeout(timer);
      reject(new SafeError('Document extraction stopped before completion.'));
    });
  });
}

export async function loadInputs(selections: Selection[], config: Config): Promise<Input[]> {
  validateConfig(config);
  if (!selections.length || selections.length > MAX_INPUTS ||
      !selections.some(selection => selection.role === 'requirements')) {
    throw new SafeError(`Select requirements and at most ${MAX_INPUTS} total inputs.`);
  }
  const seen = new Set<string>();
  const result: Input[] = [];
  let total = 0;
  let extracted = 0;
  for (const selection of selections) {
    if (!['requirements', 'checklist', 'artifact'].includes(selection.role)) {
      throw new SafeError('Invalid input role.');
    }
    validatePath(selection.path);
    const ext = path.extname(selection.path).toLowerCase();
    if (!config.allowedExtensions.includes(ext) || (selection.role === 'checklist' && ext !== '.json')) {
      throw new SafeError('Unsupported input type. Check allowed extensions; checklists must be JSON.');
    }
    await assertNoSymlinks(selection.path);
    const canonical = await fs.realpath(selection.path);
    if (seen.has(canonical)) { throw new SafeError('Duplicate inputs are not permitted.'); }
    seen.add(canonical);
    const handle = await fs.open(selection.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let data: Buffer;
    try {
      const stat = await handle.stat();
      await assertNoSymlinks(selection.path);
      const current = await fs.stat(selection.path);
      if (!stat.isFile() || stat.nlink !== 1 || stat.ino !== current.ino || stat.dev !== current.dev ||
          canonical !== await fs.realpath(selection.path)) {
        throw new SafeError('Inputs must be stable regular files, not links or special files.');
      }
      const limit = Math.min(config.maxFileSizeMB * 1024 * 1024, MAX_TOTAL_BYTES - total);
      if (stat.size > limit) { throw new SafeError('Selected inputs exceed the file or total size limit.'); }
      // Bound the actual read as well as the initial stat, including files growing during reading.
      data = Buffer.alloc(Math.floor(limit) + 1);
      let bytes = 0;
      while (bytes < data.length) {
        const read = await handle.read(data, bytes, data.length - bytes, null);
        if (read.bytesRead === 0) { break; }
        bytes += read.bytesRead;
      }
      if (bytes > limit) { throw new SafeError('Selected inputs exceed the file or total size limit.'); }
      data = data.subarray(0, bytes);
      total += bytes;
    } finally { await handle.close(); }
    const text = ext === '.pdf' || ext === '.docx' ? await extractInWorker(data, ext) : decodeText(data);
    if (!text.trim()) { throw new SafeError('Selected inputs must contain extractable text. Scanned PDFs require OCR before selection.'); }
    extracted += Buffer.byteLength(text);
    if (extracted > MAX_TEXT_BYTES) { throw new SafeError('Total extracted input exceeds 2 MiB.'); }
    let content: string | object = text;
    if (ext === '.json') {
      try {
        const parsed: unknown = JSON.parse(text);
        if (!parsed || typeof parsed !== 'object') { throw new Error(); }
        content = parsed;
      } catch { throw new SafeError('JSON inputs must contain a valid object or array.'); }
    }
    result.push({ id: `input-${result.length + 1}`, name: selection.label ?? path.basename(selection.path), role: selection.role, content });
  }
  return result;
}

const SKIPPED_DIRS = new Set(['node_modules', 'dist', 'build', 'out', 'target', '__pycache__', 'venv', 'coverage']);
// Structured/binary formats need strict parsing, so folder scans cover plain-text and code files only.
const FOLDER_EXCLUDED = new Set(['.json', '.pdf', '.docx']);

// Expands an explicitly chosen folder into file selections; links, dot-directories and build output are skipped.
export async function expandFolder(root: string, config: Config): Promise<Selection[]> {
  validateConfig(config);
  await assertNoSymlinks(root);
  if (!(await fs.lstat(root)).isDirectory()) { throw new SafeError('Select a folder.'); }
  const found: Selection[] = [];
  let bytes = 0;
  let scanned = 0;
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 10) { return; }
    for (const name of (await fs.readdir(dir)).sort()) {
      if (++scanned > 20_000) { throw new SafeError('Folder has too many entries. Choose a smaller folder.'); }
      const full = path.join(dir, name);
      const stat = await fs.lstat(full);
      if (stat.isDirectory()) {
        if (!name.startsWith('.') && !SKIPPED_DIRS.has(name)) { await walk(full, depth + 1); }
        continue;
      }
      const ext = path.extname(name).toLowerCase();
      if (!stat.isFile() || stat.nlink !== 1 || stat.size === 0 || stat.size > config.maxFileSizeMB * 1024 * 1024 ||
          FOLDER_EXCLUDED.has(ext) || !config.allowedExtensions.includes(ext)) { continue; }
      bytes += stat.size;
      if (found.length >= MAX_INPUTS - 20 || bytes > MAX_TEXT_BYTES) {
        throw new SafeError('Folder has too many files or too much text (limit 2 MiB). Choose a smaller folder or subfolder.');
      }
      found.push({ path: full, role: 'artifact', label: path.relative(root, full).split(path.sep).join('/') });
    }
  };
  await walk(root, 0);
  if (!found.length) { throw new SafeError('No supported code or text files were found in that folder.'); }
  return found;
}
