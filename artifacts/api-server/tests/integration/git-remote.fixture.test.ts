import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { simpleGit } from "simple-git";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createEphemeralRemote,
  type EphemeralRemote,
} from "../fixtures/git-remote";

describe("ephemeral git remote fixture", () => {
  let remote: EphemeralRemote;

  beforeAll(async () => {
    remote = await createEphemeralRemote();
    await remote.seed(
      {
        "00-Inbox/hello.md": "# hello\n\nseeded note\n",
        "Journal/2026-05-15.md": "# 2026-05-15\n",
      },
      "initial seed",
    );
  });

  afterAll(async () => {
    await remote.cleanup();
  });

  it("can be cloned and the seeded files are present on the default branch", async () => {
    const clonePath = await mkdtemp(path.join(tmpdir(), "remote-clone-"));
    await simpleGit().clone(remote.url, clonePath, ["--branch", remote.branch]);
    const note = await readFile(
      path.join(clonePath, "00-Inbox/hello.md"),
      "utf8",
    );
    expect(note).toContain("seeded note");
  });
});
