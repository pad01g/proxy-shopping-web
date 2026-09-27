import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { MemoryStorage } from './memory.js';

/**
 * Node-only storage: an in-memory map mirrored to a single JSON file.
 * Writes are serialised and atomic (write temp file, then rename).
 */
export class FileStorage extends MemoryStorage {
  private writing: Promise<void> = Promise.resolve();

  private constructor(private readonly path: string) {
    super();
  }

  static async open(path: string): Promise<FileStorage> {
    const s = new FileStorage(path);
    try {
      const obj = JSON.parse(await readFile(path, 'utf8')) as Record<string, string>;
      for (const [k, v] of Object.entries(obj)) s.data.set(k, v);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    return s;
  }

  override async put<T>(key: string, value: T): Promise<void> {
    await super.put(key, value);
    await this.flush();
  }

  override async delete(key: string): Promise<void> {
    await super.delete(key);
    await this.flush();
  }

  private flush(): Promise<void> {
    const snapshot = JSON.stringify(Object.fromEntries(this.data));
    this.writing = this.writing.then(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.tmp`;
      await writeFile(tmp, snapshot);
      await rename(tmp, this.path);
    });
    return this.writing;
  }
}
