# opencode-task-checker

OpenCode 插件：为长时间执行的任务提供 **3 分钟无响应确认**，并在助手回复终止信号（`已完成` / `遇到不可抗力`）时自动中断任务。

**dist 文件完全自包含，无运行时依赖，离线可安装。**

## 兼容性

| OpenCode 版本 | 插件入口 | 状态 |
| --- | --- | --- |
| V2（`>= 2.0`） | `default export { id, setup }` | ✅ 已适配 |
| V1（`>= 1.18.29`） | `default export { id, server }` | ✅ 保留兼容 |

同一个包内同时导出 `setup`（V2）与 `server`（V1），两套 API 各自独立运行，互不影响。

## 功能特性

- **静默监测**：默认关闭，通过 `/jiance` 开启
- **物理拦截**：斜杠指令由插件层消费，LLM 完全无感知，不污染上下文
- **防误杀**：会话正在 `busy` 执行时，控制指令不会强行掐断业务工作
- **3 分钟超时**：会话空闲且距上次交互超过 3 分钟时，自动向会话发送确认提示
- **终止信号**：助手回复包含 `已完成` 或 `遇到不可抗力` 时，自动中断任务

## 命令由插件自带（V2 重要变更）

V1 时期需要你在 `opencode.json` 里手写 `command.jiance*`（template 提交给模型，再由插件拦截）。**V2 改为插件通过 `command.transform` 自己注册命令**，无需在配置里再写 `command`。

> [!IMPORTANT]
> 如果你的配置里仍然存在 V1 时代的 `command.jiance` / `command.jiance-off` / `command.jiance-s`，**请删除它们**。
> V2 中配置里的命令优先级高于插件注册的同名命令，保留旧定义会导致 `/jiance` 被当成普通提示词提交给模型（错误行为）。

## 安装

### 方式一：本地目录 + file:// 声明（推荐，离线可用）

```bash
chmod +x install.sh && ./install.sh
```

脚本会把插件复制到 `~/.config/opencode/plugins/opencode-task-checker/`（含自包含的 `index.js`），并把 `plugin` 声明写入全局配置的 `plugin`/`plugins` 字段。

手动安装等价操作：

```jsonc
// ~/.config/opencode/opencode.json(c) 或 .opencode/opencode.json
{
  // V2 字段名是 plugins；V1 为 plugin（两者都会被读取）
  "plugins": [
    "file:///home/<用户名>/.config/opencode/plugins/opencode-task-checker"
  ]
}
```

```bash
# 目录结构（index.js 必须是自包含的构建产物，否则热重载时相对 re-export 会命中模块缓存）
~/.config/opencode/plugins/opencode-task-checker/
├── index.js        # = dist/index.js 的副本（入口）
├── dist/index.js   # 构建产物
└── package.json
```

> 声明路径必须用 `file://<绝对路径>`（或绝对路径 / `.` 开头）。`file:xxx`（单冒号）不会命中路径分支；未发布的包名会被 `Npm.add` 静默跳过。

### 方式二：从 npm 安装

```bash
opencode plugin opencode-task-checker -g        # 首次
opencode plugin opencode-task-checker -g -f     # 更新
```

```jsonc
{ "plugins": ["opencode-task-checker"] }
```

### 重启 OpenCode 使插件生效

```bash
opencode service restart          # V2
# 或：systemctl --user restart opencode.service   # V1
```

重启后日志应出现 `[task-checker] [INFO] Task checker plugin configuration loaded`（V2 会带 `(V2 setup)` 后缀）。

## 交互命令

| 命令 | 说明 |
|------|------|
| `/jiance` | 开启当前会话的 3 分钟任务状态监测 |
| `/jiance-off` | 关闭当前会话的任务状态检测，释放后台计时器 |
| `/jiance-s` | 查询当前会话的监测累计时间与距下次确认时间 |

### 关于反馈提示（V2 限制）

- **V1**：通过 `client.tui.showToast` 在界面弹出即时 Toast。
- **V2**：服务端插件 API **没有** Toast/瞬时 UI 通道（`tui.toast.show` 仅由客户端消费，插件无法发送）。任何写进会话的消息（`synthetic` / `prompt`）都会进入模型上下文造成污染，因此本插件在 V2 下**只写服务端日志**，不再注入任何会话消息。

查看操作结果：

```bash
grep '\[task-checker\]' ~/.local/share/opencode/log/opencode.log
```

## 工作原理

### V2

1. `setup(ctx)` 中通过 `ctx.command.transform` 注册 `/jiance*` 命令（`execute` 直接处理，不触发模型）
2. `ctx.session.hook("prompt", ...)` 捕获新的用户任务并重置计时器（插件自发的确认提示会被识别并跳过）
3. 每 5 秒轮询：会话空闲且距上次交互超过 3 分钟 → `ctx.session.prompt` 注入确认提示
4. `ctx.event.subscribe` 监听 `session.status` / `session.idle` / `session.text.ended`
5. 助手文本含终止信号 → `ctx.session.interrupt({ sessionID, resume: false })`

### V1

1. `command.execute.before` / `chat.message` 拦截 `/jiance*`，`client.tui.showToast` 弹出提示
2. `client.session.list` 发现会话，每 5 秒轮询
3. `experimental.text.complete` 捕获助手文本，`client.session.abort` 中断任务

## 故障排查

| 现象 | 原因 | 处理 |
|------|------|------|
| `/jiance` 被当普通文本、模型开始回复 | 配置里仍残留 V1 的 `command.jiance` 定义 | 删除配置中的 `command.jiance*` |
| `/jiance` 无反应 | 插件未加载 | 确认 `file://` 声明正确；查看日志 `loading plugin` / `failed to load plugin` |
| 热重载后仍报 `Plugin must export a default definition ...` | 入口 `index.js` 是相对 re-export，命中模块缓存 | 让 `index.js` 为自包含构建产物（`cp dist/index.js index.js`），或重启服务 |
| 加载两次 | 全局与项目配置都声明了同一插件 | 只保留全局一份 |
