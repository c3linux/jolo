// Antigravity CLI (agy) as a hosted agent, driven through its print-mode stream.
//
// One Jolo run is one agy turn. The child reads one `{"event":"user"}` line on stdin and writes NDJSON on stdout:
// `init`, then `step_update` events (the reply arrives as `text_delta`s on agent_response steps, and each tool call
// is a tool step that goes ACTIVE, then DONE or ERROR), then one `result` with the turn's status and usage. Every
// step names the conversation, and `--conversation` continues it next turn.
//
// Print mode has no channel for permission questions: a tool that agy's own rules do not allow is refused on the
// spot, listed in the result's `denied_actions`, and agy ends its turn. So Jolo cannot ask the user here, and it
// grants agy nothing of its own: edits, commands and other tools run only where agy's settings.json allows them,
// and a turn with a refusal fails, naming what to allow. Its accept-edits mode is not used, because it reaches
// repository metadata such as .git/config, which Jolo keeps out of every agent's reach.
//
// Every shape below was read from agy 1.3.5 in live print-mode sessions.
import { createHostedTurn, handoffParties, hostedEnvironment, recall, runChoice, spawnLineChild } from "./hosted.js";
import { createSummarizer, handoffPrompt } from "./handoff.js";
import { inlineBrowserInstructions } from '../browser/instructions.js';
import { standaloneChatInstructions } from '../agent/instructions.js';

/**
 * The print-mode stream, as the binary spells it. The turn's scratch directory joins the workspace, and `--print=`
 * names an empty prompt, so the turn is read from stdin.
 */
export const antigravityArgv = (binary, extraArgs, scratchDir, conversationId) => [
  binary, ...extraArgs, "--input-format", "stream-json", "--output-format", "stream-json", "--add-dir", scratchDir,
  ...(conversationId ? ["--conversation", conversationId] : []),
  "--print=",
];

/**
 * @param {{ storage: any, catalog: any, permissions: any, supervisor: any, log: any, providerFactory?: any, settings?: any }} deps
 */
export function createAntigravityExecutor({ storage, catalog, permissions, supervisor, log, providerFactory = null, settings = null }) {
  return {
    name: "antigravity-stream",
    /** @param {any} ctx @param {any} [answerer] the agent answering this run, when a message called one in (§4.3) */
    async execute(ctx, answerer = null) {
      const { run, signal } = ctx;
      const session = storage.getSession(run.sessionId);
      const workspace = storage.getWorkspace(session.workspaceId);
      const manifest = answerer ?? catalog.get(session.agentId);
      const [binary, ...extraArgs] = catalog.command(manifest, runChoice(ctx.run)); // the --model/--effort in force, plus any the manifest adds
      const turn = createHostedTurn({ ctx, storage, permissions, manifest, session, workspace });
      const usage = { inputTokens: 0, outputTokens: 0, attempts: 1, iterations: 0 };
      // Print mode takes text content only, so an attached image would be dropped without a word.
      if (run.attachments?.some(item => item.mimeType.startsWith('image/'))) {
        turn.finish({ usage });
        return { outcome: "failed", failure: `${manifest.displayName} does not support image attachments. Choose an agent with image support.` };
      }
      const remembered = recall(session, manifest).conversationId ?? null;
      const environment = turn.environment;
      const argv = antigravityArgv(binary, extraArgs, environment.TMPDIR, remembered);
      const prompt = await handoffPrompt({ storage, run, session, resumed: Boolean(remembered), ...handoffParties({ catalog, session, manifest, storage, run, model: catalog.config(manifest, runChoice(ctx.run)).model }), summarize: createSummarizer({ providerFactory, settings, log, sessionId: session.id, runId: run.id }) });
      // Print mode has no system-prompt option, so Jolo's instructions lead the turn, as for ACP agents.
      const instructions = [inlineBrowserInstructions({ available: false, hosted: true }), standaloneChatInstructions(storage, session), turn.fileInstructions].filter(Boolean).join('\n\n');

      const state = { replies: new Map(), result: null, failure: null }; // agent_response step index -> message id
      let link;
      try {
        link = spawnLineChild({ argv, cwd: workspace.path, env: hostedEnvironment(supervisor, environment), signal, log, agentId: manifest.id });
      } catch (error) {
        turn.finish({ usage });
        return { outcome: "failed", failure: `could not start ${manifest.displayName}: ${error?.message ?? error}` };
      }

      const onReply = (step) => {
        // Each finished model step reports its own tokens; the result's usage covers the whole conversation so far.
        if (step.state !== "ACTIVE" && step.usage) {
          usage.inputTokens += (step.usage.input_tokens ?? 0) + (step.usage.cache_read_tokens ?? 0);
          usage.outputTokens += step.usage.output_tokens ?? 0;
          usage.iterations += 1;
        }
        let messageId = state.replies.get(step.step_index);
        if (!messageId && step.text_delta) {
          ctx.transition("model");
          messageId = ctx.startMessage("assistant", "text");
          state.replies.set(step.step_index, messageId);
        }
        if (messageId && step.text_delta) turn.appendBounded(messageId, step.text_delta);
        if (messageId && step.state !== "ACTIVE") { ctx.finishMessage(messageId, "complete"); state.replies.delete(step.step_index); }
      };

      const onTool = (step) => {
        const callId = String(step.step_index);
        const tool = step.tool_info ?? {};
        const name = String(step.tool_name ?? tool.name ?? "tool");
        const input = tool.parameters ?? {};
        if (!turn.hasTool(callId)) { ctx.transition("tools"); turn.toolStarted({ callId, name, input, display: `${name} ${JSON.stringify(input)}` }); }
        if (step.state === "ERROR") turn.toolFinished(callId, { text: String(tool.error?.message ?? "the tool failed"), isError: true });
        else if (step.state !== "ACTIVE") turn.toolFinished(callId, { text: typeof tool.output === "string" ? tool.output : "" });
      };

      const onMessage = (message) => {
        const conversationId = message.step_update?.conversation_id || message.result?.conversation_id;
        if (conversationId && recall(session, manifest).conversationId !== conversationId) turn.remember({ conversationId });
        if (message.event === "step_update") {
          const step = message.step_update ?? {};
          if (step.step_type === "agent_response") onReply(step);
          else if (step.step_type === "tool" || turn.hasTool(String(step.step_index))) onTool(step); // a subagent call ends as a "subagent" step
          return; // user_input and system_message steps echo what Jolo already shows
        }
        if (message.event === "result") {
          state.result = message.result ?? {};
          // The turn is over. Closing stdin ends agy (the guardian stops a child whose input ends, so not before), and
          // agy may otherwise wait on background tasks after answering.
          link.end();
          link.terminate({ graceful: true });
        }
      };

      ctx.transition("model");
      link.write({ event: "user", message: { content: `${instructions}\n\nCurrent request:\n${prompt}` } });
      try {
        for await (const message of link.messages()) onMessage(message);
      } catch (error) {
        state.failure = String(error?.message ?? error);
      }
      const { exitCode, stderr } = await link.settle();
      for (const messageId of state.replies.values()) ctx.finishMessage(messageId, "interrupted");
      turn.finish({ usage });
      if (signal.aborted) return { outcome: "cancelled" };
      if (state.failure) return { outcome: "failed", failure: state.failure.slice(0, 500) };
      if (!state.result) return { outcome: "failed", failure: `${manifest.displayName} exited ${exitCode ?? "?"} without a result${stderr ? `: ${stderr.slice(0, 300)}` : ""}` };
      if (state.result.status !== "SUCCESS") return { outcome: "failed", failure: `${manifest.displayName}: ${String(state.result.error || state.result.status || "error")}`.slice(0, 500) };
      // A refused step can even read DONE, so the result's list is what says agy stopped short.
      // Each refusal names agy's permission key ("command", "write_file"), which is also how its allow rules are spelled.
      const denied = (state.result.denied_actions ?? []).map((action) => action?.action || action?.display_name).filter(Boolean);
      if (denied.length) return { outcome: "failed", failure: `${manifest.displayName} refused ${denied.join(", ")}: its print mode cannot ask for permission. Allow it with a rule such as ${denied[0]}(<target>) under permissions.allow in ~/.gemini/antigravity-cli/settings.json.`.slice(0, 500) };
      return { outcome: "completed" };
    },
  };
}
