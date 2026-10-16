import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** Object-storage boundary for raw snapshots and exported files. Local disk by default; S3-compatible for deployment. */
export interface StorageAdapter {
  readonly driver: string;
  put(key: string, data: Buffer | string, contentType?: string): Promise<void>;
  get(key: string): Promise<Buffer | null>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
}

function safeKey(key: string): string {
  const k = key.replace(/\\/g, '/');
  if (k.includes('..') || k.startsWith('/') || /[\0]/.test(k)) throw new Error(`Unsafe storage key: ${key}`);
  return k;
}

export class LocalStorage implements StorageAdapter {
  readonly driver = 'local';
  constructor(private readonly root: string) {}

  private resolve(key: string) {
    const full = path.resolve(this.root, safeKey(key));
    if (!full.startsWith(path.resolve(this.root))) throw new Error('Storage path escapes root');
    return full;
  }

  async put(key: string, data: Buffer | string): Promise<void> {
    const file = this.resolve(key);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, data);
  }

  async get(key: string): Promise<Buffer | null> {
    try {
      return await readFile(this.resolve(key));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.resolve(key), { force: true });
  }

  async exists(key: string): Promise<boolean> {
    try {
      await stat(this.resolve(key));
      return true;
    } catch {
      return false;
    }
  }
}

export class MemoryStorage implements StorageAdapter {
  readonly driver = 'memory';
  readonly objects = new Map<string, Buffer>();
  async put(key: string, data: Buffer | string) {
    this.objects.set(safeKey(key), Buffer.isBuffer(data) ? data : Buffer.from(data));
  }
  async get(key: string) {
    return this.objects.get(safeKey(key)) ?? null;
  }
  async delete(key: string) {
    this.objects.delete(safeKey(key));
  }
  async exists(key: string) {
    return this.objects.has(safeKey(key));
  }
}
