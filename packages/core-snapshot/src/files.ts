import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync, closeSync, constants, copyFileSync, existsSync, fsyncSync,
  lstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, renameSync,
  statSync, unlinkSync, writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";

export class SnapshotError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "SnapshotError";
  }
}

export function within(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (path !== ".." && !path.startsWith(".." + sep) && !isAbsolute(path));
}

function optionalStat(path: string) {
  return lstatSync(path, { throwIfNoEntry: false });
}

export class PathPolicy {
  readonly roots: string[];
  private readonly blocked: string[];
  constructor(roots: string[], stateDir: string, protectedPaths: readonly string[]) {
    if (!roots.length) throw new SnapshotError("ROOT", "Select a writable directory.");
    this.roots = roots.map(root => {
      const absolute = realpathSync.native(resolve(root));
      if (!statSync(absolute).isDirectory() || absolute === parse(absolute).root)
        throw new SnapshotError("ROOT", "Select a directory below the filesystem root: " + root);
      return absolute;
    });
    const home = homedir();
    this.blocked = [
      stateDir, ...protectedPaths, ...[".ssh", ".gnupg", ".aws", ".minder", ".codex", ".dsh", ".pi"].map(name => join(home, name)),
      ...(process.platform === "win32"
        ? [process.env.SystemRoot || "C:\\Windows", process.env.ProgramFiles || "C:\\Program Files",
          process.env.ProgramData || "C:\\ProgramData", process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)"]
        : ["/System", "/Library", "/etc", "/private/etc", "/bin", "/sbin", "/usr", "/proc", "/sys", "/dev", "/boot",
          "/mnt/c/Windows", "/mnt/c/Program Files", "/mnt/c/Program Files (x86)", "/mnt/c/ProgramData"]),
    ].flatMap(p => existsSync(p) ? [resolve(p), realpathSync.native(p)] : [resolve(p)]);
  }
  file(input: string): string {
    return this.check(input, false);
  }
  directory(input: string): string {
    return this.check(input, true);
  }
  private check(input: string, directory: boolean): string {
    if (!input || input.includes("\0"))
      throw new SnapshotError("PATH", "Invalid file path.");
    const path = resolve(this.roots[0]!, input);
    if (process.platform === "win32" && (path.startsWith("\\\\") || path.slice(2).includes(":") ||
        path.slice(3).split(sep).some(part => /[. ]$|^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(part))))
      throw new SnapshotError("PATH", "Unsupported Windows path: " + path);
    if (basename(path).startsWith(".minder-tx-")) throw new SnapshotError("PATH", "Reserved staging name.");
    const root = this.roots.find(r => within(r, path) && (directory || r !== path));
    if (!root) throw new SnapshotError("OUTSIDE_ROOT", "Outside configured roots: " + path);
    const components = relative(root, path).split(sep).filter(Boolean);
    if (path.split(sep).some(part => [".git", ".ssh", ".gnupg"].includes(part.toLowerCase())))
      throw new SnapshotError("PROTECTED", "Protected directory: " + path);
    let cursor = root;
    if (realpathSync.native(root) !== root) throw new SnapshotError("SYMLINK", "Root changed: " + root);
    for (const [i, part] of components.entries()) {
      cursor = join(cursor, part);
      const item = optionalStat(cursor);
      if (item?.isSymbolicLink()) throw new SnapshotError("SYMLINK", "Symbolic link or junction: " + cursor);
      if (i < components.length - 1 && !item?.isDirectory())
        throw new SnapshotError("PARENT", "Parent directory unavailable: " + cursor);
      if (i === components.length - 1) {
        if (directory && !item?.isDirectory())
          throw new SnapshotError("TYPE", "Select an existing directory: " + cursor);
        if (!directory && item && (!item.isFile() || item.nlink > 1))
          throw new SnapshotError("TYPE", "Only unaliased regular files can be managed: " + cursor);
      }
    }
    const canonical = optionalStat(path) ? realpathSync.native(path) : join(realpathSync.native(dirname(path)), basename(path));
    const folded = (s: string) => s.normalize("NFC").toLowerCase();
    if (!within(root, canonical) || this.blocked.some(p => within(folded(p), folded(canonical))))
      throw new SnapshotError("PROTECTED", "Protected path: " + canonical);
    return canonical;
  }
}

export function hashFile(path: string): string {
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.allocUnsafe(256 * 1024);
    const hash = createHash("sha256");
    let length: number;
    while ((length = readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, length));
    return hash.digest("hex");
  } finally { closeSync(fd); }
}

export function flushFile(path: string): void {
  const fd = openSync(path, "r+");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

export function flushDirectory(path: string): void {
  if (process.platform === "win32") return;
  const fd = openSync(path, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

/** 查询挂载卷对给定权限的实际表示，用于校验历史记录。 */
export function effectiveMode(path: string, requested: number): number {
  const probe = join(dirname(path), ".minder-tx-" + randomUUID());
  const fd = openSync(probe, "wx", 0o600);
  try {
    chmodSync(probe, requested);
    return statSync(probe).mode & 0o777;
  } finally {
    closeSync(fd);
    unlinkSync(probe);
  }
}

function copy(source: string, destination: string): void {
  try {
    copyFileSync(source, destination, constants.COPYFILE_FICLONE_FORCE | constants.COPYFILE_EXCL);
  } catch (error) {
    if (!["EXDEV", "ENOSYS", "ENOTSUP", "EOPNOTSUPP", "ENOTTY", "EINVAL"].includes((error as NodeJS.ErrnoException).code || "")) throw error;
    copyFileSync(source, destination, constants.COPYFILE_EXCL);
  }
}

export class ObjectStore {
  readonly dir: string;
  constructor(stateDir: string) {
    this.dir = join(stateDir, "objects");
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
  }
  save(value: Uint8Array | string, sourceFile = false): string {
    const temp = join(this.dir, ".pending-" + randomUUID());
    try {
      if (sourceFile) copy(value as string, temp);
      else writeFileSync(temp, value, { flag: "wx", mode: 0o600 });
      chmodSync(temp, 0o600);
      const hash = hashFile(temp);
      if (!existsSync(join(this.dir, hash))) {
        flushFile(temp);
        renameSync(temp, join(this.dir, hash));
        flushDirectory(this.dir);
      }
      return hash;
    } finally { if (existsSync(temp)) unlinkSync(temp); }
  }
  buffer(hash: string): Buffer { return readFileSync(join(this.dir, hash)); }
  publish(hash: string | null, mode: number, path: string, scratch: string, modeChanged: (actual: number) => void): void {
    if (hash === null) {
      unlinkSync(path);
    } else {
      const source = join(this.dir, hash);
      if (hashFile(source) !== hash) throw new SnapshotError("CORRUPT", "Damaged snapshot object: " + hash);
      const stage = join(dirname(path), ".minder-tx-" + scratch);
      if (optionalStat(stage)) unlinkSync(stage);
      try {
        copy(source, stage);
        // 在恢复原始权限之前同步，允许恢复只读文件。
        flushFile(stage);
        chmodSync(stage, mode);
        const actualMode = statSync(stage).mode & 0o777;
        if (actualMode !== mode) modeChanged(actualMode);
        renameSync(stage, path);
      } finally { if (optionalStat(stage)) unlinkSync(stage); }
    }
    flushDirectory(dirname(path));
  }
}
