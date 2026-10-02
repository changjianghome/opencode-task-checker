// src/index.ts
var CHECK_INTERVAL_MS = 5e3;
var PROMPT_TIMEOUT_MS = 18e4;
var CHECK_PROMPT_TEXT = "\u5982\u679C\u5DF2\u7ECF\u5B8C\u6210\u5DE5\u4F5C,\u8BF7\u56DE\u590D\u201C\u5DF2\u5B8C\u6210\u201D,\u5982\u679C\u6CA1\u6709\u5B8C\u6210,\u8BF7\u7EE7\u7EED\u5F53\u524D\u7684\u5DE5\u4F5C\u4E0D\u9700\u8981\u8FDB\u884C\u56DE\u590D,\u5982\u679C\u5F53\u524D\u4EFB\u52A1\u9047\u5230\u4F60\u4E0D\u53EF\u514B\u670D\u7684\u963B\u529B\u8BF7\u56DE\u590D\u201C\u9047\u5230\u4E0D\u53EF\u6297\u529B\u201D,\u4E0D\u8981\u6709\u522B\u7684\u4EFB\u4F55\u7684\u591A\u4F59\u5185\u5BB9";
var CHECK_PROMPT_SIGNATURE = "\u5982\u679C\u5DF2\u7ECF\u5B8C\u6210\u5DE5\u4F5C,\u8BF7\u56DE\u590D\u201C\u5DF2\u5B8C\u6210\u201D";
var DONE_SIGNAL = "\u5DF2\u5B8C\u6210";
var BLOCKED_SIGNAL = "\u9047\u5230\u4E0D\u53EF\u6297\u529B";
function short(sid) {
  return sid.length > 12 ? `...${sid.slice(-8)}` : sid;
}
async function log(level, message) {
  try {
    console.error(`[task-checker] [${level.toUpperCase()}] ${message}`);
  } catch {
  }
}
function createState() {
  return {
    status: "idle",
    taskStartTime: null,
    lastPromptTime: null,
    hasPromptedForCheck: false,
    monitoringEnabled: false
    // 默认关闭监测
  };
}
function minSec(ms) {
  const totalMin = Math.floor(ms / 6e4);
  const totalSec = Math.floor(ms % 6e4 / 1e3);
  return `${totalMin}\u5206${totalSec}\u79D2`;
}
function computeCommandReply(cmd, w) {
  let message = "";
  let variant = "info";
  if (cmd === "jiance") {
    if (!w.monitoringEnabled) {
      w.monitoringEnabled = true;
      const now = Date.now();
      w.taskStartTime = now;
      w.lastPromptTime = now;
      message = "\u3010\u4EFB\u52A1\u76D1\u6D4B\u3011\u5F53\u524D\u4F1A\u8BDD\u5DF2\u6FC0\u6D3B\u76D1\u6D4B\uFF0C\u76D1\u6D4B\u65F6\u957F3\u5206\u949F\u3002";
      variant = "success";
    } else {
      message = "\u3010\u4EFB\u52A1\u76D1\u6D4B\u3011\u5F53\u524D\u4F1A\u8BDD\u5DF2\u6FC0\u6D3B\u76D1\u6D4B\uFF0C\u65E0\u9700\u91CD\u590D\u5F00\u542F\u3002";
    }
  } else if (cmd === "jiance-off") {
    if (w.monitoringEnabled) {
      w.monitoringEnabled = false;
      w.taskStartTime = null;
      w.lastPromptTime = null;
      message = "\u3010\u4EFB\u52A1\u76D1\u6D4B\u3011\u5F53\u524D\u4F1A\u8BDD\u7684\u4EFB\u52A1\u72B6\u6001\u68C0\u6D4B\u5DF2\u5173\u95ED\u3002";
      variant = "warning";
    } else {
      message = "\u3010\u4EFB\u52A1\u76D1\u6D4B\u3011\u5F53\u524D\u4F1A\u8BDD\u672A\u5F00\u542F\u72B6\u6001\u68C0\u6D4B\u3002";
    }
  } else if (cmd === "jiance-s") {
    if (w.monitoringEnabled) {
      const totalElapsed = Date.now() - (w.taskStartTime ?? Date.now());
      const timeSinceLast = Date.now() - (w.lastPromptTime ?? Date.now());
      const remaining = Math.max(0, PROMPT_TIMEOUT_MS - timeSinceLast);
      message = `\u3010\u4EFB\u52A1\u76D1\u6D4B\u3011\u76D1\u6D4B\u4E2D\u3002\u5DF2\u7D2F\u8BA1\u76D1\u6D4B\uFF1A${minSec(totalElapsed)}\uFF0C\u8DDD\u79BB\u4E0B\u4E00\u6B21\u786E\u8BA4\uFF1A${minSec(remaining)}\u3002`;
      variant = "info";
    } else {
      message = "\u3010\u4EFB\u52A1\u76D1\u6D4B\u3011\u5F53\u524D\u4F1A\u8BDD\u5C1A\u672A\u5F00\u542F\u4EFB\u52A1\u72B6\u6001\u76D1\u6D4B\u3002\u53EF\u7528 /jiance \u5F00\u542F\u3002";
      variant = "warning";
    }
  }
  return { message, variant };
}
function isTerminationSignal(text) {
  return { done: text.includes(DONE_SIGNAL), blocked: text.includes(BLOCKED_SIGNAL) };
}
var TaskCheckerPlugin = async (ctx, options) => {
  const sessions = /* @__PURE__ */ new Map();
  let timer = null;
  let discoveryTimer = null;
  let debugCounter = 0;
  function getSid(ev) {
    const props = ev.properties;
    const sid = ev.sessionID ?? props?.sessionID ?? props?.part?.sessionID ?? props?.info?.sessionID;
    if (sid && typeof sid === "string" && sid.startsWith("ses_")) {
      return sid;
    }
    return void 0;
  }
  function ensureWatch(sid) {
    let w = sessions.get(sid);
    if (!w) {
      w = createState();
      sessions.set(sid, w);
    }
    return w;
  }
  function extractMessages(response) {
    if (!response) return [];
    if (Array.isArray(response)) return response;
    if (Array.isArray(response.data)) return response.data;
    if (Array.isArray(response.messages)) return response.messages;
    return [];
  }
  async function discoverSessions() {
    try {
      const response = await ctx.client.session.list();
      const list = extractMessages(response);
      for (const s of list) {
        const sid = s.id;
        if (sid && typeof sid === "string" && sid.startsWith("ses_")) {
          const w = ensureWatch(sid);
          if (s.status) {
            w.status = s.status;
            if (w.monitoringEnabled && s.status === "busy" && w.taskStartTime === null) {
              const now = Date.now();
              w.taskStartTime = now;
              w.lastPromptTime = now;
              await log("info", `Discovered busy session ${short(sid)}: Timer initialized.`);
            }
          }
        }
      }
    } catch (err) {
      await log("debug", `Discover sessions failed: ${err.message}`);
    }
  }
  async function checkSessionsLoop() {
    const now = Date.now();
    debugCounter++;
    for (const [sid, w] of sessions) {
      if (w.monitoringEnabled) {
        if (debugCounter % 3 === 0) {
          const elapsed = w.lastPromptTime ? Math.round((now - w.lastPromptTime) / 1e3) : -1;
          await log(
            "debug",
            `Session ${short(sid)} details: status=${w.status}, taskStartTime=${w.taskStartTime}, lastPromptTime=${w.lastPromptTime}, elapsed=${elapsed}s, hasPrompted=${w.hasPromptedForCheck}`
          );
        }
      }
      if (!w.monitoringEnabled || w.taskStartTime === null || w.lastPromptTime === null) continue;
      if (w.status === "busy") continue;
      if (now - w.lastPromptTime >= PROMPT_TIMEOUT_MS) {
        await log(
          "info",
          `Session ${short(sid)} running for ${Math.round((now - w.taskStartTime) / 6e4)}m. Sending check prompt...`
        );
        w.lastPromptTime = now;
        w.hasPromptedForCheck = true;
        try {
          await ctx.client.session.prompt({
            path: { id: sid },
            body: {
              parts: [{ type: "text", text: CHECK_PROMPT_TEXT }],
              agent: w.agent,
              model: w.model
            }
          });
          await log("info", `Prompt sent to session ${short(sid)}.`);
        } catch (err) {
          await log("error", `Failed to send prompt to ${short(sid)}: ${err.message}`);
          w.hasPromptedForCheck = false;
        }
      }
    }
  }
  discoverSessions();
  timer = setInterval(checkSessionsLoop, CHECK_INTERVAL_MS);
  if (timer.unref) timer.unref();
  discoveryTimer = setInterval(discoverSessions, 3e4);
  if (discoveryTimer.unref) discoveryTimer.unref();
  async function handleEvent(ev) {
    const sid = getSid(ev);
    if (!sid) return;
    const w = ensureWatch(sid);
    if (ev.type === "session.status") {
      const status = ev.status ?? ev.properties?.status;
      const statusType = status?.type ?? "unknown";
      w.status = statusType;
    } else if (ev.type === "session.idle") {
      w.status = "idle";
    } else if (ev.type === "session.created") {
      w.status = "idle";
    }
  }
  async function showToast(message, variant) {
    try {
      await ctx.client.tui.showToast({
        body: { title: "\u4EFB\u52A1\u76D1\u6D4B", message, variant, duration: 5e3 }
      });
    } catch (err) {
      await log("error", `Failed to show toast: ${err.message}`);
    }
  }
  return {
    dispose: async () => {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      if (discoveryTimer) {
        clearInterval(discoveryTimer);
        discoveryTimer = null;
      }
      await log("info", "Task checker plugin disposed.");
    },
    event: async ({ event }) => {
      await handleEvent(event);
    },
    config: async () => {
      await log("info", "Task checker plugin configuration loaded.");
    },
    // 拦截命令系统路由，不通知模型
    "command.execute.before": async (input, output) => {
      const sid = input.sessionID;
      const cmd = input.command;
      if (cmd === "jiance" || cmd === "jiance-off" || cmd === "jiance-s") {
        output.parts = [];
        const w = ensureWatch(sid);
        const wasBusy = w.status === "busy";
        if (!wasBusy) {
          try {
            await ctx.client.session.abort({ path: { id: sid } });
          } catch {
          }
        }
        setTimeout(async () => {
          try {
            if (input.messageID) {
              await ctx.client.session.revert({ path: { id: sid }, body: { messageID: input.messageID } });
            }
          } catch {
          }
        }, 500);
        const reply = computeCommandReply(cmd, w);
        await log("info", `Session ${short(sid)}: ${cmd} handled via command.execute.before.`);
        await showToast(reply.message, reply.variant);
      }
    },
    // 完全拦截并阻断斜杠指令流，不通知模型，不引起模型回复
    "chat.message": async (input, output) => {
      const sid = input.sessionID;
      const w = ensureWatch(sid);
      let allText = "";
      if (output.parts) {
        for (const part of output.parts) {
          if (part.type === "text") {
            allText += part.text ?? "";
          }
        }
      }
      const trimmed = allText.trim();
      if (trimmed === "/jiance" || trimmed === "/jiance-off" || trimmed === "/jiance-s") {
        output.parts = [];
        const cmd = trimmed.slice(1);
        const wasBusy = w.status === "busy";
        if (!wasBusy) {
          try {
            await ctx.client.session.abort({ path: { id: sid } });
          } catch {
          }
        }
        setTimeout(async () => {
          try {
            if (input.messageID) {
              await ctx.client.session.revert({
                path: { id: sid },
                body: { messageID: input.messageID }
              });
              await log("info", `Session ${short(sid)}: Instruction message reverted from history.`);
            }
          } catch (revertErr) {
            await log("warn", `Session ${short(sid)}: Revert failed: ${revertErr.message}`);
          }
        }, 500);
        const reply = computeCommandReply(cmd, w);
        await log("info", `Session ${short(sid)}: ${cmd} handled via chat.message.`);
        await showToast(reply.message, reply.variant);
      } else if (trimmed.includes(CHECK_PROMPT_SIGNATURE)) {
        await log("debug", `Session ${short(sid)}: Self check-prompt event bypassed in chat.message.`);
      } else {
        if (input.agent) w.agent = input.agent;
        if (input.model) {
          w.model = { providerID: input.model.providerID, modelID: input.model.modelID };
        }
        if (w.monitoringEnabled) {
          const now = Date.now();
          w.taskStartTime = now;
          w.lastPromptTime = now;
          w.hasPromptedForCheck = false;
          await log("info", `Session ${short(sid)}: New normal task detected. Timer initialized.`);
        }
      }
    },
    // 大模型文本生成完成钩子：捕获刚输出完毕的消息文本，零时差拦截终止
    "experimental.text.complete": async (input, output) => {
      const sid = input.sessionID;
      const w = sessions.get(sid);
      if (w && w.hasPromptedForCheck) {
        w.hasPromptedForCheck = false;
        const cleanedText = (output.text ?? "").trim();
        await log("info", `Session ${short(sid)} experimental complete text: "${cleanedText}"`);
        const { done, blocked } = isTerminationSignal(cleanedText);
        if (done || blocked) {
          await log(
            "info",
            `Session ${short(sid)} complete text contains termination signal ("${done ? DONE_SIGNAL : BLOCKED_SIGNAL}"). Aborting task.`
          );
          try {
            await ctx.client.session.abort({ path: { id: sid } });
            await log("info", `Session ${short(sid)} abort success.`);
          } catch (abortErr) {
            await log("warn", `Abort session ${short(sid)} failed: ${abortErr.message}`);
          }
          w.taskStartTime = null;
          w.lastPromptTime = null;
        } else {
          await log("info", `Session ${short(sid)} did not request termination. Task continues.`);
        }
      }
    }
  };
};
async function setupV2(ctx) {
  const sessions = /* @__PURE__ */ new Map();
  let timer = null;
  let debugCounter = 0;
  const controller = new AbortController();
  function ensureWatch(sid) {
    let w = sessions.get(sid);
    if (!w) {
      w = createState();
      sessions.set(sid, w);
    }
    return w;
  }
  async function runCommand(cmd, sid) {
    const w = ensureWatch(sid);
    const reply = computeCommandReply(cmd, w);
    await log("info", `Session ${short(sid)}: ${cmd} -> ${reply.message}`);
  }
  await ctx.command.transform((editor) => {
    editor.add({
      name: "jiance",
      description: "\u5F00\u542F3\u5206\u949F\u4EFB\u52A1\u72B6\u6001\u76D1\u6D4B",
      execute: async (inv) => {
        await runCommand("jiance", inv.sessionID);
      }
    });
    editor.add({
      name: "jiance-off",
      description: "\u5173\u95ED\u4EFB\u52A1\u72B6\u6001\u76D1\u6D4B",
      execute: async (inv) => {
        await runCommand("jiance-off", inv.sessionID);
      }
    });
    editor.add({
      name: "jiance-s",
      description: "\u67E5\u8BE2\u5F53\u524D\u4EFB\u52A1\u72B6\u6001\u76D1\u6D4B\u8BE6\u60C5",
      execute: async (inv) => {
        await runCommand("jiance-s", inv.sessionID);
      }
    });
  });
  await ctx.session.hook("prompt", async (event) => {
    const sid = event?.sessionID;
    if (!sid) return;
    const text = String(event?.prompt?.text ?? "").trim();
    if (text.includes(CHECK_PROMPT_SIGNATURE)) {
      await log("debug", `Session ${short(sid)}: Self check-prompt bypassed in V2 prompt hook.`);
      return;
    }
    const w = ensureWatch(sid);
    if (w.monitoringEnabled) {
      const now = Date.now();
      w.taskStartTime = now;
      w.lastPromptTime = now;
      w.hasPromptedForCheck = false;
      await log("info", `Session ${short(sid)}: New normal task detected. Timer initialized.`);
    }
  });
  async function onAssistantText(sid, w, text) {
    if (!w.hasPromptedForCheck) return;
    w.hasPromptedForCheck = false;
    const cleanedText = text.trim();
    await log("info", `Session ${short(sid)} assistant text: "${cleanedText}"`);
    const { done, blocked } = isTerminationSignal(cleanedText);
    if (done || blocked) {
      await log(
        "info",
        `Session ${short(sid)} text contains termination signal ("${done ? DONE_SIGNAL : BLOCKED_SIGNAL}"). Interrupting task.`
      );
      try {
        await ctx.session.interrupt({ sessionID: sid, resume: false });
        await log("info", `Session ${short(sid)} interrupt success.`);
      } catch (err) {
        await log("warn", `Interrupt session ${short(sid)} failed: ${err?.message ?? err}`);
      }
      w.taskStartTime = null;
      w.lastPromptTime = null;
    } else {
      await log("info", `Session ${short(sid)} did not request termination. Task continues.`);
    }
  }
  function handleEvent(event) {
    if (!event || typeof event.type !== "string") return;
    const data = event.data ?? event.properties ?? {};
    const sid = data.sessionID ?? event.sessionID;
    if (!sid || typeof sid !== "string") return;
    const w = ensureWatch(sid);
    if (event.type === "session.status") {
      const status = data.status;
      w.status = typeof status === "string" ? status : status?.type ?? "unknown";
    } else if (event.type === "session.idle") {
      w.status = "idle";
    } else if (event.type === "session.created") {
      w.status = "idle";
    } else if (event.type === "session.text.ended") {
      void onAssistantText(sid, w, String(data.text ?? "")).catch(
        (err) => log("warn", `onAssistantText failed: ${err?.message ?? err}`)
      );
    }
  }
  async function checkSessionsLoop() {
    const now = Date.now();
    debugCounter++;
    for (const [sid, w] of sessions) {
      if (w.monitoringEnabled && debugCounter % 3 === 0) {
        const elapsed = w.lastPromptTime ? Math.round((now - w.lastPromptTime) / 1e3) : -1;
        await log(
          "debug",
          `Session ${short(sid)} details: status=${w.status}, taskStartTime=${w.taskStartTime}, lastPromptTime=${w.lastPromptTime}, elapsed=${elapsed}s, hasPrompted=${w.hasPromptedForCheck}`
        );
      }
      if (!w.monitoringEnabled || w.taskStartTime === null || w.lastPromptTime === null) continue;
      if (w.status === "busy") continue;
      if (now - w.lastPromptTime >= PROMPT_TIMEOUT_MS) {
        await log(
          "info",
          `Session ${short(sid)} running for ${Math.round((now - w.taskStartTime) / 6e4)}m. Sending check prompt...`
        );
        w.lastPromptTime = now;
        w.hasPromptedForCheck = true;
        try {
          await ctx.session.prompt({ sessionID: sid, text: CHECK_PROMPT_TEXT });
          await log("info", `Prompt sent to session ${short(sid)}.`);
        } catch (err) {
          await log("error", `Failed to send prompt to ${short(sid)}: ${err?.message ?? err}`);
          w.hasPromptedForCheck = false;
        }
      }
    }
  }
  timer = setInterval(() => {
    void checkSessionsLoop().catch((err) => log("error", `checkSessionsLoop failed: ${err?.message ?? err}`));
  }, CHECK_INTERVAL_MS);
  if (timer.unref) timer.unref();
  void (async () => {
    try {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        try {
          handleEvent(event);
        } catch (err) {
          await log("warn", `handleEvent failed: ${err?.message ?? err}`);
        }
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        await log("warn", `event subscription ended: ${err?.message ?? err}`);
      }
    }
  })();
  await log("info", "Task checker plugin configuration loaded (V2 setup).");
  return async () => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    controller.abort();
    await log("info", "Task checker plugin disposed.");
  };
}
var index_default = {
  id: "opencode-task-checker",
  server: TaskCheckerPlugin,
  // V1
  setup: setupV2
  // V2
};
export {
  TaskCheckerPlugin,
  index_default as default
};
