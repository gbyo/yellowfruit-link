/**
 * Write a file so that a crash cannot leave a truncated one.
 *
 * # The guarantee
 *
 * After this function returns, the destination holds the complete new contents. If the process dies
 * at any point before that, the destination holds the complete *old* contents. There is no moment at
 * which it holds half of either. That matters here because the destination is the only copy of
 * received results and live session state: a truncated file would mean a room was told "accepted" for
 * a game this application can no longer produce.
 *
 * # How
 *
 * Write a fresh temporary file in the same directory, flush it to the device, and only then rename it
 * over the destination. A same-directory rename is atomic on the filesystems this application runs
 * on. The directory is flushed afterwards so that the rename itself survives a power loss.
 *
 * Windows may refuse to rename over a path that already exists. The fallback moves the old complete
 * file aside first, installs the flushed replacement, and puts the old file back if that fails - so
 * an ordinary permission error cannot erase the previous copy, which an unlink-then-rename could.
 *
 * The filesystem is injectable because the failure this code exists for cannot be provoked on a real
 * disk on demand, and an untested recovery path is not a recovery path.
 */
import fs from 'fs';
import path from 'path';
import { randomBytes } from 'crypto';

export interface IAtomicFileHandle {
  writeFile(data: string, encoding: 'utf8'): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

export interface IAtomicFileSystem {
  open(filePath: string, flags: string, mode?: number): Promise<IAtomicFileHandle>;
  rename(source: string, destination: string): Promise<void>;
  unlink(filePath: string): Promise<void>;
  syncDirectory?(directory: string): Promise<void>;
  /** Injectable so the Windows replacement path can be exercised on a POSIX machine. */
  platform?: string;
}

export const realFileSystem: IAtomicFileSystem = {
  open: async (filePath, flags, mode) => {
    const handle = await fs.promises.open(filePath, flags, mode);
    return {
      writeFile: (data, encoding) => handle.writeFile(data, { encoding }),
      sync: () => handle.sync(),
      close: () => handle.close(),
    };
  },
  rename: (source, destination) => fs.promises.rename(source, destination),
  unlink: (filePath) => fs.promises.unlink(filePath),
  syncDirectory: async (directory) => {
    // Windows does not allow opening a directory this way, so this is best effort there.
    try {
      const handle = await fs.promises.open(directory, 'r');
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (process.platform !== 'win32') throw error;
    }
  },
};

function temporaryPathFor(filePath: string): string {
  const basename = path.basename(filePath);
  return path.join(path.dirname(filePath), `.${basename}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`);
}

function backupPathFor(filePath: string): string {
  const basename = path.basename(filePath);
  return path.join(path.dirname(filePath), `.${basename}.${process.pid}.${randomBytes(8).toString('hex')}.bak`);
}

function isWindowsReplacementError(error: unknown, platform: string): boolean {
  const code = (error as { code?: string } | null)?.code;
  return platform === 'win32' && (code === 'EEXIST' || code === 'EPERM' || code === 'EBUSY');
}

async function tryUnlink(filePath: string, fileSystem: IAtomicFileSystem): Promise<void> {
  try {
    await fileSystem.unlink(filePath);
  } catch {
    // Cleanup must never hide the original persistence failure.
  }
}

export async function writeFileAtomically(
  filePath: string,
  contents: string,
  fileSystem: IAtomicFileSystem = realFileSystem,
): Promise<void> {
  const temporaryPath = temporaryPathFor(filePath);
  const platform = fileSystem.platform ?? process.platform;
  let handle: IAtomicFileHandle | undefined;
  try {
    handle = await fileSystem.open(temporaryPath, 'wx', 0o600);
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;

    try {
      await fileSystem.rename(temporaryPath, filePath);
    } catch (error) {
      if (!isWindowsReplacementError(error, platform)) throw error;

      const backupPath = backupPathFor(filePath);
      let movedOriginal = false;
      let backupCanBeCleaned = true;
      try {
        try {
          await fileSystem.rename(filePath, backupPath);
          movedOriginal = true;
        } catch (backupError) {
          // No destination yet is fine; anything else means the original replace error stands.
          if ((backupError as { code?: string } | null)?.code !== 'ENOENT') throw error;
        }
        await fileSystem.rename(temporaryPath, filePath);
      } catch (replacementError) {
        if (movedOriginal) {
          try {
            await fileSystem.rename(backupPath, filePath);
          } catch {
            // Keep the backup where an operator can find it if the restore also failed.
            backupCanBeCleaned = false;
          }
        }
        throw replacementError;
      } finally {
        if (backupCanBeCleaned) await tryUnlink(backupPath, fileSystem);
      }
    }

    if (fileSystem.syncDirectory) await fileSystem.syncDirectory(path.dirname(filePath));
  } finally {
    if (handle) {
      try {
        await handle.close();
      } catch {
        // Preserve the original write/flush error.
      }
    }
    await tryUnlink(temporaryPath, fileSystem);
  }
}
