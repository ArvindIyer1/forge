import { constants } from "node:fs";
import { lstat, open, readdir, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep, win32 } from "node:path";
import { TextDecoder } from "node:util";

export const MAX_READ_BYTES = 1_048_576;
export const MAX_SEARCH_BYTES = 10 * 1_048_576;
export const MAX_LIST_ENTRIES = 500;
export const MAX_SEARCH_FILES = 500;
export const MAX_SEARCH_RESULTS = 100;
export const MAX_DIRECTORY_DEPTH = 8;

export interface WorkspaceFileSnapshot {
  relativePath: string;
  content: string;
  size: number;
  device: number;
  inode: number;
  modifiedAt: number;
  mode: number;
}

export interface NewFileTarget {
  relativePath: string;
  absolutePath: string;
}

const ignoredDirectories = new Set(["node_modules", "dist", "coverage", ".git"]);

export class Workspace {
  private constructor(readonly root: string) {}

  static async create(root: string): Promise<Workspace> {
    const canonicalRoot = await realpath(root);
    const rootInfo = await stat(canonicalRoot);
    if (!rootInfo.isDirectory()) {
      throw new Error("FORGE_WORKSPACE must point to a directory.");
    }
    return new Workspace(canonicalRoot);
  }

  async resolveExisting(relativePath: string): Promise<string> {
    const segments = normalizeSegments(relativePath);
    if (segments.some(isSensitiveSegment)) {
      throw new Error("Access to this path is blocked because it may contain secrets.");
    }

    let currentPath = this.root;
    for (const segment of segments) {
      currentPath = join(currentPath, segment);
      const info = await lstat(currentPath);
      if (info.isSymbolicLink()) {
        throw new Error("Symbolic links cannot be accessed through workspace tools.");
      }
    }

    const canonicalPath = await realpath(currentPath);
    if (!isInside(this.root, canonicalPath)) {
      throw new Error("The requested path is outside the configured workspace.");
    }
    return canonicalPath;
  }

  /** Validate a new file destination without creating or modifying anything. */
  async resolveNewFileTarget(relativePath: string): Promise<NewFileTarget> {
    const segments = normalizeSegments(relativePath);
    if (segments.length === 0 || segments.some(isSensitiveSegment)) {
      throw new Error("A safe workspace-relative file path is required.");
    }

    const fileName = segments.at(-1)!;
    const parentSegments = segments.slice(0, -1);
    const parentRelativePath = parentSegments.join("/") || ".";
    const parentPath = await this.resolveExisting(parentRelativePath);
    const parentInfo = await stat(parentPath);
    if (!parentInfo.isDirectory()) throw new Error("The parent path is not a directory.");

    const absolutePath = join(parentPath, fileName);
    try {
      await lstat(absolutePath);
      throw new Error("write_file only creates new files and cannot overwrite an existing path.");
    } catch (error) {
      if (!isMissingPath(error)) throw error;
    }

    const normalizedPath = segments.join("/");
    if (!isInside(this.root, absolutePath)) {
      throw new Error("The requested path is outside the configured workspace.");
    }
    return { relativePath: normalizedPath, absolutePath };
  }

  async resolveExistingFileTarget(relativePath: string): Promise<NewFileTarget> {
    const absolutePath = await this.resolveExisting(relativePath);
    const info = await stat(absolutePath);
    if (!info.isFile()) throw new Error("The requested path is not a regular file.");
    return {
      relativePath: toRelativePosix(this.root, absolutePath),
      absolutePath,
    };
  }

  async readTextSnapshot(relativePath: string, maxBytes = MAX_READ_BYTES): Promise<WorkspaceFileSnapshot> {
    const filePath = await this.resolveExisting(relativePath);
    const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
    const file = await open(filePath, flags);

    try {
      const info = await file.stat();
      if (!info.isFile()) throw new Error("The requested path is not a regular file.");
      if (info.size > maxBytes) throw new Error(`File exceeds the ${maxBytes}-byte read limit.`);

      const buffer = Buffer.alloc(maxBytes + 1);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      if (bytesRead > maxBytes) throw new Error(`File exceeds the ${maxBytes}-byte read limit.`);
      const contentBytes = buffer.subarray(0, bytesRead);
      if (contentBytes.includes(0)) throw new Error("Binary files cannot be read by workspace tools.");

      let content: string;
      try {
        content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(contentBytes);
      } catch {
        throw new Error("File is not valid UTF-8 text.");
      }

      return {
        relativePath: toRelativePosix(this.root, filePath),
        content,
        size: info.size,
        device: info.dev,
        inode: info.ino,
        modifiedAt: info.mtimeMs,
        mode: info.mode,
      };
    } finally {
      await file.close();
    }
  }

  async readTextFile(relativePath: string, maxBytes = MAX_READ_BYTES): Promise<string> {
    return (await this.readTextSnapshot(relativePath, maxBytes)).content;
  }

  async listFiles(
    relativePath = ".",
    recursive = true,
  ): Promise<{ files: string[]; truncated: boolean }> {
    const startPath = await this.resolveExisting(relativePath);
    const startInfo = await stat(startPath);
    if (startInfo.isFile()) {
      return { files: [toRelativePosix(this.root, startPath)], truncated: false };
    }
    if (!startInfo.isDirectory()) throw new Error("The requested path is not a file or directory.");

    const files: string[] = [];
    let truncated = false;

    const walk = async (directory: string, depth: number): Promise<void> => {
      if (depth > MAX_DIRECTORY_DEPTH || files.length >= MAX_LIST_ENTRIES) {
        truncated = true;
        return;
      }

      const entries = await readdir(directory, { withFileTypes: true });
      entries.sort((left, right) => left.name.localeCompare(right.name));

      for (const entry of entries) {
        if (files.length >= MAX_LIST_ENTRIES) {
          truncated = true;
          return;
        }

        const candidate = join(directory, entry.name);
        const relativeCandidate = toRelativePosix(this.root, candidate);
        if (isSensitivePath(relativeCandidate) || entry.isSymbolicLink()) continue;
        if (entry.isDirectory() && ignoredDirectories.has(entry.name.toLowerCase())) continue;

        if (entry.isFile()) {
          files.push(relativeCandidate);
        } else if (entry.isDirectory() && recursive) {
          try {
            const verifiedPath = await this.resolveExisting(relativeCandidate);
            await walk(verifiedPath, depth + 1);
          } catch (error) {
            if (!isMissingPath(error) && !isSymlinkError(error)) throw error;
          }
        }
      }
    };

    await walk(startPath, 0);
    return { files, truncated };
  }
}

export function isSensitivePath(path: string): boolean {
  return normalizePathSeparators(path)
    .split("/")
    .filter(Boolean)
    .some(isSensitiveSegment);
}

function normalizeSegments(input: string): string[] {
  if (!input || input.includes("\0")) throw new Error("A valid workspace-relative path is required.");
  if (isAbsolute(input) || win32.isAbsolute(input)) {
    throw new Error("Absolute paths are not allowed; use a path relative to the workspace.");
  }

  const segments = normalizePathSeparators(input).split("/").filter((part) => part && part !== ".");
  if (segments.some((part) => part === "..")) {
    throw new Error("Path traversal is not allowed.");
  }
  return segments;
}

function normalizePathSeparators(path: string): string {
  return path.replaceAll("\\", "/");
}

function isSensitiveSegment(segment: string): boolean {
  const name = basename(segment).toLowerCase();
  return (
    name === ".env" ||
    name.startsWith(".env.") ||
    name === ".git" ||
    name === ".ssh" ||
    name === ".aws" ||
    name === ".npmrc" ||
    name === ".pypirc" ||
    name === "credentials" ||
    name.startsWith("credentials.") ||
    name === "secrets" ||
    name.startsWith("secrets.") ||
    name === "id_rsa" ||
    name.startsWith("id_rsa.") ||
    name === "id_ed25519" ||
    name.startsWith("id_ed25519.") ||
    /\.(pem|key|p12|pfx)$/i.test(name)
  );
}

function isInside(root: string, target: string): boolean {
  const pathFromRoot = relative(root, target);
  return pathFromRoot === "" || (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== ".." && !isAbsolute(pathFromRoot));
}

function toRelativePosix(root: string, target: string): string {
  return relative(root, target).split(sep).join("/") || ".";
}

function isMissingPath(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isSymlinkError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("Symbolic links");
}
