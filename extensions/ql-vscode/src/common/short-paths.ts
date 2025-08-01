import { arch, platform } from "os";
import { basename, dirname, join, normalize, resolve } from "path";
import { lstat, readdir } from "fs/promises";
import type { BaseLogger } from "./logging";
import type { KoffiFunction } from "koffi";
import { getErrorMessage } from "./helpers-pure";

/**
 * Expands a path that potentially contains 8.3 short names (e.g. "C:\PROGRA~1" instead of "C:\Program Files").
 *
 * See https://en.wikipedia.org/wiki/8.3_filename if you're not familiar with Windows 8.3 short names.
 *
 * @param shortPath The path to expand.
 * @returns A normalized, absolute path, with any short components expanded.
 */
export async function expandShortPaths(
  shortPath: string,
  logger: BaseLogger,
): Promise<string> {
  const absoluteShortPath = normalize(resolve(shortPath));
  if (platform() !== "win32") {
    // POSIX doesn't have short paths.
    return absoluteShortPath;
  }

  void logger.log(`Expanding short paths in: ${absoluteShortPath}`);
  // A quick check to see if there might be any short components.
  // There might be a case where a short component doesn't contain a `~`, but if there is, I haven't
  // found it.
  // This may find long components that happen to have a '~', but that's OK.
  if (absoluteShortPath.indexOf("~") < 0) {
    // No short components to expand.
    void logger.log(`Skipping due to no short components`);
    return absoluteShortPath;
  }

  const longPath = await expandShortPathRecursive(absoluteShortPath, logger);
  if (longPath.indexOf("~") < 0) {
    return longPath;
  }

  void logger.log(
    "Short path was not resolved to long path, using native method",
  );

  try {
    return await expandShortPathNative(absoluteShortPath, logger);
  } catch (e) {
    void logger.log(
      `Failed to expand short path using native method: ${getErrorMessage(e)}`,
    );
    return longPath;
  }
}

/**
 * Expand a single short path component
 * @param dir The absolute path of the directory containing the short path component.
 * @param shortBase The shot path component to expand.
 * @returns The expanded path component.
 */
async function expandShortPathComponent(
  dir: string,
  shortBase: string,
  logger: BaseLogger,
): Promise<string> {
  void logger.log(`Expanding short path component: ${shortBase}`);

  const fullPath = join(dir, shortBase);

  // Use `lstat` instead of `stat` to avoid following symlinks.
  const stats = await lstat(fullPath, { bigint: true });
  if (stats.dev === BigInt(0) || stats.ino === BigInt(0)) {
    // No inode info, so we won't be able to find this in the directory listing.
    void logger.log(`No inode info available. Skipping.`);
    return shortBase;
  }
  void logger.log(`dev/inode: ${stats.dev}/${stats.ino}`);

  try {
    // Enumerate the children of the parent directory, and try to find one with the same dev/inode.
    const children = await readdir(dir);
    for (const child of children) {
      void logger.log(`considering child: ${child}`);
      try {
        const childStats = await lstat(join(dir, child), { bigint: true });
        void logger.log(`child dev/inode: ${childStats.dev}/${childStats.ino}`);
        if (childStats.dev === stats.dev && childStats.ino === stats.ino) {
          // Found a match.
          void logger.log(`Found a match: ${child}`);
          return child;
        }
      } catch (e) {
        // Can't read stats for the child, so skip it.
        void logger.log(`Error reading stats for child: ${e}`);
      }
    }
  } catch (e) {
    // Can't read the directory, so we won't be able to find this in the directory listing.
    void logger.log(`Error reading directory: ${e}`);
    return shortBase;
  }

  void logger.log(`No match found. Returning original.`);
  return shortBase;
}

/**
 * Expand the short path components in a path, including those in ancestor directories.
 * @param shortPath The path to expand.
 * @returns The expanded path.
 */
async function expandShortPathRecursive(
  shortPath: string,
  logger: BaseLogger,
): Promise<string> {
  const shortBase = basename(shortPath);
  if (shortBase.length === 0) {
    // We've reached the root.
    return shortPath;
  }

  const dir = await expandShortPathRecursive(dirname(shortPath), logger);
  void logger.log(`dir: ${dir}`);
  void logger.log(`base: ${shortBase}`);
  if (shortBase.indexOf("~") < 0) {
    // This component doesn't have a short name, so just append it to the (long) parent.
    void logger.log(`Component is not a short name`);
    return join(dir, shortBase);
  }

  // This component looks like it has a short name, so try to expand it.
  const longBase = await expandShortPathComponent(dir, shortBase, logger);
  return join(dir, longBase);
}

let GetLongPathNameW: KoffiFunction | undefined;

async function expandShortPathNative(shortPath: string, logger: BaseLogger) {
  if (platform() !== "win32") {
    throw new Error("expandShortPathNative is only supported on Windows");
  }

  if (arch() !== "x64") {
    throw new Error(
      "expandShortPathNative is only supported on x64 architecture",
    );
  }

  if (GetLongPathNameW === undefined) {
    // We are using koffi/indirect here to avoid including the native addon for all
    // platforms in the bundle since this is only used on Windows. Instead, the
    // native addon is included in the Gulpfile.
    const koffi = await import("koffi/indirect");

    const lib = koffi.load("kernel32.dll");
    GetLongPathNameW = lib.func("__stdcall", "GetLongPathNameW", "uint32", [
      "str16",
      "str16",
      "uint32",
    ]);
  }

  const MAX_PATH = 32767;
  const buffer = Buffer.alloc(MAX_PATH * 2, 0);

  const result = GetLongPathNameW(shortPath, buffer, MAX_PATH);

  if (result === 0) {
    throw new Error("Failed to get long path name");
  }

  const longPath = buffer.toString("utf16le", 0, (result - 1) * 2);

  void logger.log(`Expanded short path ${shortPath} to ${longPath}`);

  return longPath;
}
