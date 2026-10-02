/**
 * opencode-task-checker
 *
 * OpenCode 任务状态监测插件：为长时间执行的任务提供 3 分钟无响应确认，
 * 并在助手回复终止信号（“已完成” / “遇到不可抗力”）时自动中断任务。
 *
 * 同时兼容两套插件 API：
 *  - OpenCode V2（>= 2.x）：default export = { id, setup }
 *  - OpenCode V1（>= 1.18.29）：default export = { id, server }
 *
 * 说明：文件刻意不引用任何运行时依赖，构建产物（dist/index.js）完全自包含。
 */

// ---------------------------------------------------------------------------
// 共用常量 / 工具
// ---------------------------------------------------------------------------

const CHECK_INTERVAL_MS = 5000; // 每 5 秒轮询检查一次
const PROMPT_TIMEOUT_MS = 180000; // 3 分钟无响应即发送确认提示
const CHECK_PROMPT_TEXT =
  '如果已经完成工作,请回复“已完成”,如果没有完成,请继续当前的工作不需要进行回复,如果当前任务遇到你不可克服的阻力请回复“遇到不可抗力”,不要有别的任何的多余内容';
// 用于识别“插件自己发出的确认提示”，避免误重置计时器
const CHECK_PROMPT_SIGNATURE = '如果已经完成工作,请回复“已完成”';
const DONE_SIGNAL = '已完成';
const BLOCKED_SIGNAL = '遇到不可抗力';

interface SessionState {
  status: string;
  taskStartTime: number | null;
  lastPromptTime: number | null;
  hasPromptedForCheck: boolean;
  monitoringEnabled: boolean;
  agent?: string;
  model?: { providerID: string; modelID: string };
}

function short(sid: string): string {
  return sid.length > 12 ? `...${sid.slice(-8)}` : sid;
}

async function log(level: 'info' | 'debug' | 'warn' | 'error', message: string): Promise<void> {
  try {
    console.error(`[task-checker] [${level.toUpperCase()}] ${message}`);
  } catch {}
}

function createState(): SessionState {
  return {
    status: 'idle',
    taskStartTime: null,
    lastPromptTime: null,
    hasPromptedForCheck: false,
    monitoringEnabled: false, // 默认关闭监测
  };
}

function minSec(ms: number): string {
  const totalMin = Math.floor(ms / 60000);
  const totalSec = Math.floor((ms % 60000) / 1000);
  return `${totalMin}分${totalSec}秒`;
}

/**
 * 处理 /jiance、/jiance-off、/jiance-s，返回需要展示给用户的文案。
 * 同时会就地修改会话监测状态。
 */
function computeCommandReply(
  cmd: string,
  w: SessionState,
): { message: string; variant: 'info' | 'success' | 'warning' } {
  let message = '';
  let variant: 'info' | 'success' | 'warning' = 'info';

  if (cmd === 'jiance') {
    if (!w.monitoringEnabled) {
      w.monitoringEnabled = true;
      const now = Date.now();
      w.taskStartTime = now;
      w.lastPromptTime = now;
      message = '【任务监测】当前会话已激活监测，监测时长3分钟。';
      variant = 'success';
    } else {
      message = '【任务监测】当前会话已激活监测，无需重复开启。';
    }
  } else if (cmd === 'jiance-off') {
    if (w.monitoringEnabled) {
      w.monitoringEnabled = false;
      w.taskStartTime = null;
      w.lastPromptTime = null;
      message = '【任务监测】当前会话的任务状态检测已关闭。';
      variant = 'warning';
    } else {
      message = '【任务监测】当前会话未开启状态检测。';
    }
  } else if (cmd === 'jiance-s') {
    if (w.monitoringEnabled) {
      const totalElapsed = Date.now() - (w.taskStartTime ?? Date.now());
      const timeSinceLast = Date.now() - (w.lastPromptTime ?? Date.now());
      const remaining = Math.max(0, PROMPT_TIMEOUT_MS - timeSinceLast);
      message = `【任务监测】监测中。已累计监测：${minSec(totalElapsed)}，距离下一次确认：${minSec(remaining)}。`;
      variant = 'info';
    } else {
      message = '【任务监测】当前会话尚未开启任务状态监测。可用 /jiance 开启。';
      variant = 'warning';
    }
  }

  return { message, variant };
}

function isTerminationSignal(text: string): { done: boolean; blocked: boolean } {
  return { done: text.includes(DONE_SIGNAL), blocked: text.includes(BLOCKED_SIGNAL) };
}

// ---------------------------------------------------------------------------
// OpenCode V1 实现（1.18.29+）：default export 的 server 字段
// ---------------------------------------------------------------------------

export const TaskCheckerPlugin = async (ctx: any, options?: any) => {
  const sessions = new Map<string, SessionState>();
  let timer: any = null;
  let discoveryTimer: any = null;
  let debugCounter = 0;

  function getSid(ev: any): string | undefined {
    const props = ev.properties;
    const sid = ev.sessionID ?? props?.sessionID ?? props?.part?.sessionID ?? props?.info?.sessionID;
    if (sid && typeof sid === 'string' && sid.startsWith('ses_')) {
      return sid;
    }
    return undefined;
  }

  function ensureWatch(sid: string): SessionState {
    let w = sessions.get(sid);
    if (!w) {
      w = createState();
      sessions.set(sid, w);
    }
    return w;
  }

  function extractMessages(response: any): any[] {
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
        if (sid && typeof sid === 'string' && sid.startsWith('ses_')) {
          const w = ensureWatch(sid);
          if (s.status) {
            w.status = s.status;
            if (w.monitoringEnabled && s.status === 'busy' && w.taskStartTime === null) {
              const now = Date.now();
              w.taskStartTime = now;
              w.lastPromptTime = now;
              await log('info', `Discovered busy session ${short(sid)}: Timer initialized.`);
            }
          }
        }
      }
    } catch (err: any) {
      await log('debug', `Discover sessions failed: ${err.message}`);
    }
  }

  async function checkSessionsLoop() {
    const now = Date.now();
    debugCounter++;
    for (const [sid, w] of sessions) {
      if (w.monitoringEnabled) {
        if (debugCounter % 3 === 0) {
          const elapsed = w.lastPromptTime ? Math.round((now - w.lastPromptTime) / 1000) : -1;
          await log(
            'debug',
            `Session ${short(sid)} details: status=${w.status}, taskStartTime=${w.taskStartTime}, lastPromptTime=${w.lastPromptTime}, elapsed=${elapsed}s, hasPrompted=${w.hasPromptedForCheck}`,
          );
        }
      }

      if (!w.monitoringEnabled || w.taskStartTime === null || w.lastPromptTime === null) continue;
      // 只有当会话闲置时（即工具执行完，或者生成了当前批次的回复时），才发送询问 Prompt
      if (w.status === 'busy') continue;

      if (now - w.lastPromptTime >= PROMPT_TIMEOUT_MS) {
        await log(
          'info',
          `Session ${short(sid)} running for ${Math.round((now - w.taskStartTime) / 60000)}m. Sending check prompt...`,
        );
        w.lastPromptTime = now;
        w.hasPromptedForCheck = true;
        try {
          await ctx.client.session.prompt({
            path: { id: sid },
            body: {
              parts: [{ type: 'text', text: CHECK_PROMPT_TEXT }],
              agent: w.agent,
              model: w.model,
            },
          });
          await log('info', `Prompt sent to session ${short(sid)}.`);
        } catch (err: any) {
          await log('error', `Failed to send prompt to ${short(sid)}: ${err.message}`);
          w.hasPromptedForCheck = false;
        }
      }
    }
  }

  discoverSessions();
  timer = setInterval(checkSessionsLoop, CHECK_INTERVAL_MS);
  if (timer.unref) timer.unref();

  discoveryTimer = setInterval(discoverSessions, 30000);
  if (discoveryTimer.unref) discoveryTimer.unref();

  async function handleEvent(ev: any) {
    const sid = getSid(ev);
    if (!sid) return;
    const w = ensureWatch(sid);
    if (ev.type === 'session.status') {
      const status = ev.status ?? ev.properties?.status;
      const statusType = status?.type ?? 'unknown';
      w.status = statusType;
    } else if (ev.type === 'session.idle') {
      w.status = 'idle';
    } else if (ev.type === 'session.created') {
      w.status = 'idle';
    }
  }

  async function showToast(message: string, variant: string) {
    try {
      await ctx.client.tui.showToast({
        body: { title: '任务监测', message, variant, duration: 5000 },
      });
    } catch (err: any) {
      await log('error', `Failed to show toast: ${err.message}`);
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
      await log('info', 'Task checker plugin disposed.');
    },
    event: async ({ event }: { event: any }) => {
      await handleEvent(event);
    },
    config: async () => {
      await log('info', 'Task checker plugin configuration loaded.');
    },
    // 拦截命令系统路由，不通知模型
    'command.execute.before': async (input: any, output: any) => {
      const sid = input.sessionID;
      const cmd = input.command;
      if (cmd === 'jiance' || cmd === 'jiance-off' || cmd === 'jiance-s') {
        output.parts = [];
        const w = ensureWatch(sid);
        // 物理防掐断保护：会话忙碌时不 abort，避免误杀业务
        const wasBusy = w.status === 'busy';
        if (!wasBusy) {
          try {
            await ctx.client.session.abort({ path: { id: sid } });
          } catch {}
        }
        // 延迟回退，避开数据库插入的时序竞争
        setTimeout(async () => {
          try {
            if (input.messageID) {
              await ctx.client.session.revert({ path: { id: sid }, body: { messageID: input.messageID } });
            }
          } catch {}
        }, 500);
        const reply = computeCommandReply(cmd, w);
        await log('info', `Session ${short(sid)}: ${cmd} handled via command.execute.before.`);
        await showToast(reply.message, reply.variant);
      }
    },
    // 完全拦截并阻断斜杠指令流，不通知模型，不引起模型回复
    'chat.message': async (input: any, output: any) => {
      const sid = input.sessionID;
      const w = ensureWatch(sid);

      let allText = '';
      if (output.parts) {
        for (const part of output.parts) {
          if (part.type === 'text') {
            allText += part.text ?? '';
          }
        }
      }

      const trimmed = allText.trim();

      if (trimmed === '/jiance' || trimmed === '/jiance-off' || trimmed === '/jiance-s') {
        // 1. 拦截指令：直接将模型的输入内容清空
        output.parts = [];

        const cmd = trimmed.slice(1); // 去掉前导 "/"
        // 2. 物理防掐断保护：忙碌时不 abort
        const wasBusy = w.status === 'busy';
        if (!wasBusy) {
          try {
            await ctx.client.session.abort({ path: { id: sid } });
          } catch {}
        }

        // 3. 延迟回退，避开数据库插入的时序竞争
        setTimeout(async () => {
          try {
            if (input.messageID) {
              await ctx.client.session.revert({
                path: { id: sid },
                body: { messageID: input.messageID },
              });
              await log('info', `Session ${short(sid)}: Instruction message reverted from history.`);
            }
          } catch (revertErr: any) {
            await log('warn', `Session ${short(sid)}: Revert failed: ${revertErr.message}`);
          }
        }, 500);

        // 4. 执行状态控制逻辑与文案生成
        const reply = computeCommandReply(cmd, w);
        await log('info', `Session ${short(sid)}: ${cmd} handled via chat.message.`);
        await showToast(reply.message, reply.variant);
      } else if (trimmed.includes(CHECK_PROMPT_SIGNATURE)) {
        await log('debug', `Session ${short(sid)}: Self check-prompt event bypassed in chat.message.`);
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
          await log('info', `Session ${short(sid)}: New normal task detected. Timer initialized.`);
        }
      }
    },
    // 大模型文本生成完成钩子：捕获刚输出完毕的消息文本，零时差拦截终止
    'experimental.text.complete': async (input: any, output: any) => {
      const sid = input.sessionID;
      const w = sessions.get(sid);
      if (w && w.hasPromptedForCheck) {
        w.hasPromptedForCheck = false;

        const cleanedText = (output.text ?? '').trim();
        await log('info', `Session ${short(sid)} experimental complete text: "${cleanedText}"`);

        const { done, blocked } = isTerminationSignal(cleanedText);
        if (done || blocked) {
          await log(
            'info',
            `Session ${short(sid)} complete text contains termination signal ("${done ? DONE_SIGNAL : BLOCKED_SIGNAL}"). Aborting task.`,
          );
          try {
            await ctx.client.session.abort({ path: { id: sid } });
            await log('info', `Session ${short(sid)} abort success.`);
          } catch (abortErr: any) {
            await log('warn', `Abort session ${short(sid)} failed: ${abortErr.message}`);
          }
          w.taskStartTime = null;
          w.lastPromptTime = null;
        } else {
          await log('info', `Session ${short(sid)} did not request termination. Task continues.`);
        }
      }
    },
  };
};

// ---------------------------------------------------------------------------
// OpenCode V2 实现（>= 2.x）：default export 的 setup 字段
// ---------------------------------------------------------------------------

async function setupV2(ctx: any): Promise<() => Promise<void>> {
  const sessions = new Map<string, SessionState>();
  let timer: any = null;
  let debugCounter = 0;
  const controller = new AbortController();

  function ensureWatch(sid: string): SessionState {
    let w = sessions.get(sid);
    if (!w) {
      w = createState();
      sessions.set(sid, w);
    }
    return w;
  }

  // OpenCode V2 的服务端插件没有 tui.showToast 之类的瞬时 UI 通道，且任何写进会话的
  // 消息（synthetic / prompt）都会进入模型上下文造成污染，因此这里只写服务端日志。
  async function runCommand(cmd: string, sid: string): Promise<void> {
    const w = ensureWatch(sid);
    const reply = computeCommandReply(cmd, w);
    await log('info', `Session ${short(sid)}: ${cmd} -> ${reply.message}`);
  }

  // 1) 注册 /jiance 系列命令：命令由插件自己执行，完全不触发模型
  await ctx.command.transform((editor: any) => {
    editor.add({
      name: 'jiance',
      description: '开启3分钟任务状态监测',
      execute: async (inv: any) => {
        await runCommand('jiance', inv.sessionID);
      },
    });
    editor.add({
      name: 'jiance-off',
      description: '关闭任务状态监测',
      execute: async (inv: any) => {
        await runCommand('jiance-off', inv.sessionID);
      },
    });
    editor.add({
      name: 'jiance-s',
      description: '查询当前任务状态监测详情',
      execute: async (inv: any) => {
        await runCommand('jiance-s', inv.sessionID);
      },
    });
  });

  // 2) 用户新任务接入：重置计时器（等价 V1 的 chat.message）
  await ctx.session.hook('prompt', async (event: any) => {
    const sid = event?.sessionID;
    if (!sid) return;
    const text = String(event?.prompt?.text ?? '').trim();

    if (text.includes(CHECK_PROMPT_SIGNATURE)) {
      await log('debug', `Session ${short(sid)}: Self check-prompt bypassed in V2 prompt hook.`);
      return;
    }

    const w = ensureWatch(sid);
    if (w.monitoringEnabled) {
      const now = Date.now();
      w.taskStartTime = now;
      w.lastPromptTime = now;
      w.hasPromptedForCheck = false;
      await log('info', `Session ${short(sid)}: New normal task detected. Timer initialized.`);
    }
  });

  // 3) 助手文本完成：等价 V1 的 experimental.text.complete
  async function onAssistantText(sid: string, w: SessionState, text: string): Promise<void> {
    if (!w.hasPromptedForCheck) return;
    w.hasPromptedForCheck = false;

    const cleanedText = text.trim();
    await log('info', `Session ${short(sid)} assistant text: "${cleanedText}"`);

    const { done, blocked } = isTerminationSignal(cleanedText);
    if (done || blocked) {
      await log(
        'info',
        `Session ${short(sid)} text contains termination signal ("${done ? DONE_SIGNAL : BLOCKED_SIGNAL}"). Interrupting task.`,
      );
      try {
        await ctx.session.interrupt({ sessionID: sid, resume: false });
        await log('info', `Session ${short(sid)} interrupt success.`);
      } catch (err: any) {
        await log('warn', `Interrupt session ${short(sid)} failed: ${err?.message ?? err}`);
      }
      w.taskStartTime = null;
      w.lastPromptTime = null;
    } else {
      await log('info', `Session ${short(sid)} did not request termination. Task continues.`);
    }
  }

  function handleEvent(event: any): void {
    if (!event || typeof event.type !== 'string') return;
    const data = event.data ?? event.properties ?? {};
    const sid = data.sessionID ?? event.sessionID;
    if (!sid || typeof sid !== 'string') return;
    const w = ensureWatch(sid);

    if (event.type === 'session.status') {
      const status = data.status;
      w.status = typeof status === 'string' ? status : (status?.type ?? 'unknown');
    } else if (event.type === 'session.idle') {
      w.status = 'idle';
    } else if (event.type === 'session.created') {
      w.status = 'idle';
    } else if (event.type === 'session.text.ended') {
      void onAssistantText(sid, w, String(data.text ?? '')).catch((err) =>
        log('warn', `onAssistantText failed: ${err?.message ?? err}`),
      );
    }
  }

  // 4) 轮询：3 分钟无响应则注入确认提示
  async function checkSessionsLoop(): Promise<void> {
    const now = Date.now();
    debugCounter++;
    for (const [sid, w] of sessions) {
      if (w.monitoringEnabled && debugCounter % 3 === 0) {
        const elapsed = w.lastPromptTime ? Math.round((now - w.lastPromptTime) / 1000) : -1;
        await log(
          'debug',
          `Session ${short(sid)} details: status=${w.status}, taskStartTime=${w.taskStartTime}, lastPromptTime=${w.lastPromptTime}, elapsed=${elapsed}s, hasPrompted=${w.hasPromptedForCheck}`,
        );
      }

      if (!w.monitoringEnabled || w.taskStartTime === null || w.lastPromptTime === null) continue;
      if (w.status === 'busy') continue;

      if (now - w.lastPromptTime >= PROMPT_TIMEOUT_MS) {
        await log(
          'info',
          `Session ${short(sid)} running for ${Math.round((now - w.taskStartTime) / 60000)}m. Sending check prompt...`,
        );
        w.lastPromptTime = now;
        w.hasPromptedForCheck = true;
        try {
          await ctx.session.prompt({ sessionID: sid, text: CHECK_PROMPT_TEXT });
          await log('info', `Prompt sent to session ${short(sid)}.`);
        } catch (err: any) {
          await log('error', `Failed to send prompt to ${short(sid)}: ${err?.message ?? err}`);
          w.hasPromptedForCheck = false;
        }
      }
    }
  }

  timer = setInterval(() => {
    void checkSessionsLoop().catch((err) => log('error', `checkSessionsLoop failed: ${err?.message ?? err}`));
  }, CHECK_INTERVAL_MS);
  if (timer.unref) timer.unref();

  // 5) 事件订阅：会话状态 / 助手文本完成
  void (async () => {
    try {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        try {
          handleEvent(event);
        } catch (err: any) {
          await log('warn', `handleEvent failed: ${err?.message ?? err}`);
        }
      }
    } catch (err: any) {
      if (!controller.signal.aborted) {
        await log('warn', `event subscription ended: ${err?.message ?? err}`);
      }
    }
  })();

  await log('info', 'Task checker plugin configuration loaded (V2 setup).');

  return async () => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    controller.abort();
    await log('info', 'Task checker plugin disposed.');
  };
}

export default {
  id: 'opencode-task-checker',
  server: TaskCheckerPlugin, // V1
  setup: setupV2, // V2
};
