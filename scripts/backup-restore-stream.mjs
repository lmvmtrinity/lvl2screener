import { createReadStream } from "node:fs";

/**
 * Feed an archive to a child process and return its exit code. pg_restore can
 * finish a selected section before the archive stream reaches EOF; the
 * resulting EPIPE/ERR_STREAM_DESTROYED on stdin is therefore benign. The
 * child's exit code remains authoritative for restore success or failure.
 */
export function pipeArchiveToChild(archive, child) {
  return new Promise((resolvePipe, rejectPipe) => {
    let settled = false;
    const input = createReadStream(archive);
    const cleanup = () => {
      input.unpipe(child.stdin);
      if (!input.destroyed) input.destroy();
    };
    const resolveOnce = (value) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolvePipe(value);
    };
    const rejectOnce = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      rejectPipe(error);
    };
    input.on("error", rejectOnce);
    child.on("error", rejectOnce);
    child.stdin.on("error", (error) => {
      if (
        error?.code === "EPIPE" ||
        error?.code === "ERR_STREAM_DESTROYED" ||
        error?.code === "EOF"
      )
        return;
      rejectOnce(error);
    });
    child.on("close", (code) => resolveOnce(code));
    input.pipe(child.stdin);
  });
}
