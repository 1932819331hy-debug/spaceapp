import { describe, expect, it } from "vitest";
import {
  buildCliAgentBootstrapMarkdown,
  buildSpaceAgentBootstrapPrompt
} from "../src/agent-bootstrap.js";

describe("Space agent bootstrap", () => {
  it("uses Space MCP policy without the retired Coder Rooms catalog", () => {
    const prompt = buildSpaceAgentBootstrapPrompt({ channel: "WEB_CHAT" });
    const cliMarkdown = buildCliAgentBootstrapMarkdown();

    expect(prompt).not.toContain("discover/use tools through Space MCP policy only");
    expect(prompt).not.toContain("space-mcp-actions");
    expect(prompt).not.toContain("space-skill-actions");
    expect(prompt).not.toContain("space-memory-actions");
    expect(prompt).not.toContain("gemini_session_coder_rooms");
    expect(cliMarkdown).not.toContain("gemini_session_coder_rooms");
  });

  it("includes only selected bridge instructions without starting tool discovery", () => {
    const prompt = buildSpaceAgentBootstrapPrompt({ channel: "WEB_CHAT", selectedToolIds: ["skills:read"] });
    expect(prompt).toContain("space-skill-actions");
    expect(prompt).not.toContain("space-mcp-actions");
    expect(prompt).not.toContain("space-memory-actions");
  });

  it("points source-stack bootstrap memory guidance at the configured owned root", () => {
    const previousRoot = process.env.SPACE_MEMORY_ROOT;
    process.env.SPACE_MEMORY_ROOT = "/tmp/source-stack-owned-memory";
    try {
      const prompt = buildSpaceAgentBootstrapPrompt({ channel: "WEB_CHAT" });
      expect(prompt).toContain("/tmp/source-stack-owned-memory/gemini.md");
      expect(prompt).toContain("/tmp/source-stack-owned-memory/gemini_history.md");
      expect(prompt).toContain("Treat Space Memory in /tmp/source-stack-owned-memory as canonical");
      expect(prompt).toContain("native filesystem tools");
      expect(prompt).toContain("do not use an installed-instance memory bridge");
      expect(prompt).toContain("current source checkout's CONTRIBUTING.md");
      expect(prompt).not.toContain("Treat Space Memory in /opt/spaceapp/docs as canonical");
      expect(prompt).not.toContain("/opt/spaceapp/bin/space-memory");
    } finally {
      if (previousRoot === undefined) delete process.env.SPACE_MEMORY_ROOT;
      else process.env.SPACE_MEMORY_ROOT = previousRoot;
    }
  });

  it("keeps source CLI instructions off installed workspaces and task scripts", () => {
    const previousRoot = process.env.SPACE_MEMORY_ROOT;
    process.env.SPACE_MEMORY_ROOT = "/tmp/source-cli-owned-memory";
    try {
      const markdown = buildCliAgentBootstrapMarkdown();
      expect(markdown).toContain("Use the current source checkout for Space source-code tasks");
      expect(markdown).toContain("Read or write canonical Space Memory directly under the configured source-stack memory root");
      expect(markdown).toContain("native filesystem tools");
      expect(markdown).toContain("/tmp/source-cli-owned-memory");
      expect(markdown).toContain("never use an installed-instance memory bridge");
      expect(markdown).toContain("use verified Space API task capabilities for the current source stack");
      expect(markdown).not.toContain("/opt/spaceapp");
      expect(markdown).not.toContain("Treat /etc as the default operational workspace");
    } finally {
      if (previousRoot === undefined) delete process.env.SPACE_MEMORY_ROOT;
      else process.env.SPACE_MEMORY_ROOT = previousRoot;
    }
  });

  it("requires CLI agents to publish final deliverables without leaking inputs or secrets", () => {
    const cliMarkdown = buildCliAgentBootstrapMarkdown();
    const webPrompt = buildSpaceAgentBootstrapPrompt({ channel: "WEB_CHAT" });

    expect(cliMarkdown).toContain("space-publish-file <absolute-path>");
    expect(cliMarkdown).toContain("ONLY create and publish an Agent File if the user EXPLICITLY requested");
    expect(cliMarkdown).toContain("Publish only final deliverables");
    expect(cliMarkdown).toContain("Never publish credentials, secrets, user inputs, temporary files, caches, logs, or whole source trees");
    expect(cliMarkdown).toContain("Confirm the command returned an Agent Files artifact id");
    expect(webPrompt).not.toContain("space-publish-file <absolute-path>");
  });
});
