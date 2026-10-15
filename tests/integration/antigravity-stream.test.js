import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ROOT, startEngine, tempHome, waitFor, removeHome } from "./helpers.js";

const engines = [];
const homes = [];
afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.stop();
  for (const dir of homes.splice(0)) removeHome(dir);
});

const FAKE = path.join(ROOT, "tests", "fixtures", "fake-agy.js");
const TERMINAL = ["completed", "failed", "cancelled", "interrupted"];

/** A profile whose "antigravity" is the protocol fixture, so nothing here reaches the real CLI or its account. */
async function boot() {
  const home = tempHome(); homes.push(home);
  const repo = path.join(home, "repo");
  mkdirSync(repo, { recursive: true });
  const launcher = path.join(home, "fake-agy");
  writeFileSync(launcher, `#!/bin/sh\nif [ -f "$0.env" ]; then . "$0.env"; fi\nexec "${process.execPath}" "${FAKE}" "$@"\n`);
  chmodSync(launcher, 0o755);
  const agentsDir = path.join(home, "data", "t", "agents");
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(path.join(agentsDir, "antigravity.json"), JSON.stringify({ id: "antigravity", displayName: "Antigravity CLI", binary: launcher, transport: "antigravity-stream", modelArgs: ["--model", "{model}"], effortArgs: ["--effort", "{effort}"] }));
  const engine = await startEngine({ home });
  engines.push(engine);
  const client = await engine.connect({ clientKind: "test" });
  const events = [];
  const status = await client.call("engine.status", {});
  await client.subscribe({ after: status.cursor }, { onEvent: (event) => events.push(event) });
  const project = await client.call("project.open", { path: repo });
  const { session } = await client.call("session.create", { projectId: project.projectId, workspaceId: project.workspaceId, title: "hosted", agentId: "antigravity" });
  const runTo = async (requestId, prompt) => {
    const { run } = await client.call("run.start", { sessionId: session.id, requestId, prompt });
    await waitFor(() => events.some((e) => e.type === "run.state" && e.runId === run.id && TERMINAL.includes(e.payload.state)), { label: `${requestId} finished`, timeoutMs: 20_000 });
    return (await client.call("run.snapshot", { runId: run.id })).run;
  };
  const text = async (message) => (await client.call("artifact.read", { artifactId: message.artifactId })).text;
  const messagesOf = async (runId) => (await client.call("run.snapshot", { runId })).messages;
  /** The environment the launcher hands agy from its next start on. */
  const script = (vars) => writeFileSync(`${launcher}.env`, Object.entries(vars).map(([key, value]) => `export ${key}=${value}\n`).join(""));
  return { home, repo, client, events, session, runTo, text, messagesOf, script };
}

describe("Antigravity CLI through its print-mode stream", () => {
  test("a hosted session streams the reply, counts only this turn's tokens, and continues the same conversation next turn", async () => {
    const { events, runTo, text, messagesOf } = await boot();
    const first = await runTo("req_1", "hello there");
    expect(first.state).toBe("completed");
    const messages = await messagesOf(first.id);
    expect(messages.map((m) => [m.role, m.kind])).toEqual([["user", "text"], ["assistant", "text"]]);
    expect(await text(messages[1])).toBe("You said: hello there\n");
    expect(events.filter((e) => e.type === "message.committed" && e.runId === first.id).length).toBeGreaterThan(0); // it streamed
    expect(first.usage).toMatchObject({ inputTokens: 140, outputTokens: 6, iterations: 1 }); // the step's own count, not the conversation's

    const second = await runTo("req_2", "and again");
    expect(second.state).toBe("completed");
    expect(await text((await messagesOf(second.id))[1])).toMatch(/^Continuing conversation agy-\w+: and again\n$/); // --conversation carried the id
    expect(second.usage).toMatchObject({ inputTokens: 140, outputTokens: 6, iterations: 1 });
  }, 40_000);

  test("tool steps become Jolo tool records, and a turn agy refused something in fails with where to allow it, without asking anyone", async () => {
    const { events, repo, runTo, text, messagesOf } = await boot();
    const target = path.join(repo, "made.txt");
    const write = await runTo("req_write", `write ${target} hello from agy`);
    expect(write.state).toBe("completed");
    expect(readFileSync(target, "utf8")).toBe("hello from agy");
    const messages = await messagesOf(write.id);
    expect(messages.map((m) => m.kind)).toEqual(["text", "tool", "text"]);
    expect(await text(messages[1])).toContain(`write_to_file {"TargetFile":${JSON.stringify(target)}}`);
    expect(events.find((e) => e.type === "tool.completed" && e.runId === write.id).payload).toMatchObject({ name: "antigravity:write_to_file", status: "ok" });

    const refused = await runTo("req_cmd", "run touch should-not-exist");
    expect(refused).toMatchObject({ state: "failed", failure: "Antigravity CLI refused command: its print mode cannot ask for permission. Allow it with a rule such as command(<target>) under permissions.allow in ~/.gemini/antigravity-cli/settings.json." });
    const tool = (await messagesOf(refused.id)).find((m) => m.kind === "tool");
    expect(await text(tool)).toContain("user denied permission to run command");
    expect(events.find((e) => e.type === "tool.completed" && e.runId === refused.id).payload).toMatchObject({ name: "antigravity:run_command", status: "error" });

    // agy can report a refused step as DONE; only the result's list tells, and the run still fails.
    const quiet = await runTo("req_quiet", `refuse-write ${path.join(repo, "never.txt")}`);
    expect(quiet).toMatchObject({ state: "failed", failure: expect.stringContaining("refused write_file") });
    expect(events.some((e) => e.type === "permission.requested")).toBe(false);
  }, 40_000);

  test("a failed turn names the agent, and a cancelled turn stops it", async () => {
    const { client, events, session, runTo } = await boot();
    expect(await runTo("req_fail", "fail")).toMatchObject({ state: "failed", failure: "Antigravity CLI: scripted failure" });

    const { run } = await client.call("run.start", { sessionId: session.id, requestId: "req_hang", prompt: "hang" });
    await waitFor(() => events.some((e) => e.type === "run.state" && e.runId === run.id && e.payload.state === "model"), { label: "started" });
    await client.call("run.cancel", { runId: run.id });
    await waitFor(() => events.some((e) => e.type === "run.state" && e.runId === run.id && e.payload.state === "cancelled"), { label: "cancelled" });
  }, 40_000);

  test("the plan's limits are read per model group from /usage, and a refusal is its note and is asked again", async () => {
    const { client, script } = await boot();
    script({ FAKE_AGY_USAGE: "error" });
    expect(await client.call("agent.limits", { agentId: "antigravity", refresh: false })).toMatchObject({ windows: [], source: "none", note: "fake-agy: quota service unavailable" });
    script({});
    const report = await client.call("agent.limits", { agentId: "antigravity", refresh: false });
    expect(report).toMatchObject({ source: "agent", plan: null, note: null });
    expect(report.windows.map(({ label, usedPercent, resetsAt }) => [label, Math.round(usedPercent), resetsAt])).toEqual([
      ["Weekly · Gemini", 3, "2026-10-22T12:23:55.000Z"],
      ["5-hour · Gemini", 13, "2026-10-15T17:23:55.000Z"],
      ["Weekly · Claude and GPT", 0, "2026-10-22T16:04:01.000Z"],
      ["5-hour · Claude and GPT", 0, "2026-10-15T21:04:01.000Z"],
    ]);
  }, 40_000);

  test("the chosen model and effort reach agy as flags, and its models are offered with their thinking levels", async () => {
    const { client, runTo, text, messagesOf } = await boot();
    const report = await client.call("agent.models", { agentId: "antigravity" });
    expect(report).toMatchObject({ source: "agent", note: null, efforts: ["low", "medium", "high"] });
    expect(report.models.map(({ id, displayName, efforts }) => ({ id, displayName, efforts }))).toEqual([
      { id: "gemini-4-argon", displayName: "Gemini 4 Argon", efforts: ["low", "medium", "high"] },
      { id: "gpt-oss-120b", displayName: "GPT-OSS 120B", efforts: ["medium"] },
      { id: "custom-model", displayName: "Custom Model", efforts: [] },
    ]);

    await client.call("settings.update", { agents: { antigravity: { model: "gemini-4-argon", effort: "low" } } });
    const run = await runTo("req_model", "model");
    expect(run.state).toBe("completed");
    expect(await text((await messagesOf(run.id))[1])).toMatch(/^Running gemini-4-argon at low with \S*jolo-agent-\S+ added\.\n$/); // the turn's scratch directory
  }, 40_000);
});
