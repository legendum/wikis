import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { resolve } from 'path';

/**
 * Creates an ephemeral data directory for a test.
 * Returns cleanup function to call in afterEach/afterAll.
 */
export function createTestDataDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(resolve(tmpdir(), 'wikis-test-'));
  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}
