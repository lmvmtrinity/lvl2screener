import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { EventEmitter } from "node:events";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import test from "node:test";
import { pipeArchiveToChild } from "../backup-restore-stream.mjs";

function fakeChild({ code, stdinErrorCode }) {
  const child = new EventEmitter();
  child.stdin = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  queueMicrotask(() => {
    if (stdinErrorCode) {
      const error = new Error(stdinErrorCode);
      error.code = stdinErrorCode;
      child.stdin.emit("error", error);
    }
    child.emit("close", code);
  });
  return child;
}

test("archive pipe treats early successful child stdin closure as benign", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "backup-stream-"));
  const archive = path.join(directory, "archive.dump");
  await writeFile(archive, "archive bytes\n".repeat(10_000));
  try {
    const child = spawn(process.execPath, [
      "-e",
      "process.stdin.destroy(); process.exit(0);",
    ]);
    assert.equal(await pipeArchiveToChild(archive, child), 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("archive pipe preserves a genuine nonzero child exit", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "backup-stream-"));
  const archive = path.join(directory, "archive.dump");
  await writeFile(archive, "archive bytes\n".repeat(10_000));
  try {
    const child = spawn(process.execPath, [
      "-e",
      "process.stdin.destroy(); process.exit(7);",
    ]);
    assert.equal(await pipeArchiveToChild(archive, child), 7);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("archive pipe accepts Docker's EOF stdin closure only after a successful exit", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "backup-stream-"));
  const archive = path.join(directory, "archive.dump");
  await writeFile(archive, "archive bytes\n");
  try {
    assert.equal(
      await pipeArchiveToChild(
        archive,
        fakeChild({ code: 0, stdinErrorCode: "EOF" }),
      ),
      0,
    );
    assert.equal(
      await pipeArchiveToChild(
        archive,
        fakeChild({ code: 7, stdinErrorCode: "EOF" }),
      ),
      7,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("archive pipe rejects an unknown stdin error", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "backup-stream-"));
  const archive = path.join(directory, "archive.dump");
  await writeFile(archive, "archive bytes\n");
  try {
    await assert.rejects(
      pipeArchiveToChild(
        archive,
        fakeChild({ code: 0, stdinErrorCode: "EIO" }),
      ),
      /EIO/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
