import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { registerSkills, SKILLS } from "../src/skill.js";

const connect = async () => {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  registerSkills(server);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
};

const entry = z.object({
  uri: z.string(),
  frontmatter: z.object({ name: z.string(), description: z.string() }),
  resources: z.array(z.object({ uri: z.string(), digest: z.string(), size: z.number() })),
});

describe("skills over MCP", () => {
  it("serves every skill file as a skill:// resource and lists it with skills/list", async () => {
    const client = await connect();
    expect(client.getServerCapabilities()?.extensions).toEqual({ "io.modelcontextprotocol/skills": {} });

    const { resources } = await client.listResources();
    const files = Object.entries(SKILLS).flatMap(([name, all]) => Object.keys(all).map((file) => `skill://recordful/${name}/${file}`));
    expect(resources.map((r) => r.uri).sort()).toEqual(files.sort());

    const { skills } = await client.request({ method: "skills/list", params: {} }, z.object({ skills: z.array(entry) }));
    expect(skills.map((s) => s.frontmatter.name)).toEqual(Object.keys(SKILLS));
    for (const skill of skills) {
      expect(skill.uri).toBe(`skill://recordful/${skill.frontmatter.name}/SKILL.md`);
      expect(skill.frontmatter.description.length).toBeGreaterThan(50);
      for (const file of skill.resources) {
        const [content] = (await client.readResource({ uri: file.uri })).contents;
        const text = content && "text" in content ? content.text : "";
        expect(file.digest).toBe(`sha256:${createHash("sha256").update(text).digest("hex")}`);
        expect(file.size).toBe(Buffer.byteLength(text));
      }
    }
  });

  it("answers skills/get by URI, and -32602 for an unknown one", async () => {
    const client = await connect();
    const { skill } = await client.request(
      { method: "skills/get", params: { uri: "skill://recordful/edit-video/SKILL.md" } },
      z.object({ skill: entry }),
    );
    expect(skill.frontmatter.name).toBe("edit-video");
    await expect(
      client.request({ method: "skills/get", params: { uri: "skill://recordful/nope/SKILL.md" } }, z.object({})),
    ).rejects.toMatchObject({ code: -32602 });
  });
});
