import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { dirname, join } from 'path';
import { randomBytes } from 'crypto';

/**
 * Atomically write data to a file by writing to a temp file first,
 * then renaming. Rename is atomic on the same filesystem.
 * Matches the bash pattern: printf > .tmp.file && mv .tmp.file file
 *
 * When `keepBak` is true (default: false), the CURRENT file is copied to
 * `<filePath>.bak` before the rename.  This gives callers a single-step
 * rollback point without the cost of maintaining a full backup chain.
 * The `.bak` write is best-effort — if it fails the main write still proceeds.
 */
export function atomicWriteSync(filePath: string, data: string, keepBak = false): void {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });

  // Best-effort backup of the current file before overwriting.
  if (keepBak && existsSync(filePath)) {
    try {
      copyFileSync(filePath, filePath + '.bak');
    } catch {
      // Ignore backup errors — do not block the main write.
    }
  }

  const tmpPath = join(dir, `.tmp.${randomBytes(6).toString('hex')}`);
  try {
    writeFileSync(tmpPath, data + '\n', { encoding: 'utf-8', mode: 0o600 });
    renameSync(tmpPath, filePath);
  } catch (err) {
    // Clean up temp file on failure
    try {
      const { unlinkSync } = require('fs');
      unlinkSync(tmpPath);
    } catch {
      // Ignore cleanup errors
    }
    throw err;
  }
}

/**
 * Atomic write with a crash-durability barrier.
 *
 * `rename(2)` gives readers an all-old-or-all-new view, but by itself does not
 * guarantee that the new file or directory entry survives sudden power loss.
 * ACK receipts use this stronger variant so returning success means both the
 * content and rename have reached stable storage on Unix-like hosts.
 */
export function durableAtomicWriteSync(filePath: string, data: string): void {
  const dir = dirname(filePath);
  const missingDirs: string[] = [];
  if (process.platform !== 'win32') {
    let current = dir;
    while (!existsSync(current)) {
      missingDirs.push(current);
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }

  atomicWriteSync(filePath, data);

  let fileFd: number | undefined;
  try {
    fileFd = openSync(filePath, 'r');
    fsyncSync(fileFd);
  } finally {
    if (fileFd !== undefined) closeSync(fileFd);
  }

  // Windows does not support opening directories this way. The production
  // fleet is Unix-like; retain file durability on Windows without failing an
  // otherwise valid ACK solely on the directory barrier.
  if (process.platform !== 'win32') {
    // Sync the target directory plus every directory entry created by the
    // recursive mkdir inside atomicWriteSync. This covers a first-ever ACK in
    // a fresh state/<agent>/message-acks hierarchy without fsyncing unrelated
    // ancestors on the normal already-created path.
    const syncDirs = new Set<string>([dir]);
    for (const created of missingDirs) {
      syncDirs.add(created);
      syncDirs.add(dirname(created));
    }
    for (const directory of syncDirs) fsyncDirectorySync(directory);
  }
}

/** Remove a file and durably persist the directory-entry deletion. */
export function durableUnlinkSync(filePath: string): void {
  unlinkSync(filePath);
  if (process.platform !== 'win32') fsyncDirectorySync(dirname(filePath));
}

function fsyncDirectorySync(dirPath: string): void {
  let dirFd: number | undefined;
  try {
    dirFd = openSync(dirPath, 'r');
    fsyncSync(dirFd);
  } finally {
    if (dirFd !== undefined) closeSync(dirFd);
  }
}

/**
 * Ensure a directory exists, creating it recursively if needed.
 */
export function ensureDir(dirPath: string): void {
  mkdirSync(dirPath, { recursive: true });
}
