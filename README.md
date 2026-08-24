# opencode-task-checker

OpenCode 插件，为长时间执行的任务提供交互式 3 分钟状态检测，支持指令拦截与静默运行。**dist 文件完全自包含，无运行时依赖，离线可安装。**

## 功能特性

- **静默监测**：默认关闭，通过 `/jiance` 开启
- **物理拦截**：斜杠指令被插件层拦截并抹除，LLM 完全无感知，不污染上下文
- **Toast 弹窗**：通过 `showToast` 在 UI 右下角实时弹出监测状态
- **防误杀**：LLM 正在 `busy` 执行时，控制指令不会强行掐断业务工作
- **3 分钟超时**：任务持续 3 分钟无响应时，自动向会话发送确认提示

## 重要：插件声明方式（必读）

> [!IMPORTANT]
> 本插件**已发布到 npm**（`opencode-task-checker@1.0.3`），opencode 配置里可用**裸字符串** `"opencode-task-checker"` 声明，opencode 会从 npm 自动安装。
> **未发布/本地开发时**禁止用裸包名——那会触发 `Npm.add("opencode-task-checker@latest")` 从 npm 安装，若包不存在则**静默跳过**，`/jiance` 等命令失效且无任何报错。此时必须用 `file://<绝对路径>`（或绝对路径/`.`开头）声明；`file:xxx`（单冒号）不会命中路径分支。

## 安装

### 方式一：从 npm 安装（已发布，推荐）

```jsonc
// 在全局配置 ~/.config/opencode/opencode.json(c)（推荐，任意目录会话可用）
//    或项目配置 .opencode/opencode.json 中添加：
{
  "plugin": [
    "opencode-task-checker"
  ],
  "command": {
    "jiance": { "template": "/jiance", "description": "开启3分钟任务状态监测" },
    "jiance-off": { "template": "/jiance-off", "description": "关闭任务状态监测" },
    "jiance-s": { "template": "/jiance-s", "description": "查询当前任务状态监测详情" }
  }
}
```

```bash
# 或用 CLI 安装并写入全局配置
opencode plugin opencode-task-checker -g
# 更新到最新版时加 -f 强制替换
opencode plugin opencode-task-checker -g -f
```

> 命令定义建议放**全局配置**（`~/.config/opencode/opencode.jsonc`），否则只在定义了命令的项目目录会话中可用。

### 方式二：手动复制 + 配置文件（本地开发/离线）

```bash
# 1. 把插件复制到 opencode 的插件目录（二选一）
mkdir -p ~/.config/opencode/plugins/opencode-task-checker
cp -r dist package.json ~/.config/opencode/plugins/opencode-task-checker/
# 或项目级
mkdir -p .opencode/plugins/opencode-task-checker
cp -r dist package.json .opencode/plugins/opencode-task-checker/
```

```jsonc
// 2. 在全局配置 ~/.config/opencode/opencode.json(c)（推荐，任意目录会话可用）
//    或项目配置 .opencode/opencode.json 中添加：
{
  "plugin": [
    "file:///home/<你的用户名>/.config/opencode/plugins/opencode-task-checker"
  ],
  "command": {
    "jiance": { "template": "/jiance", "description": "开启3分钟任务状态监测" },
    "jiance-off": { "template": "/jiance-off", "description": "关闭任务状态监测" },
    "jiance-s": { "template": "/jiance-s", "description": "查询当前任务状态监测详情" }
  }
}
```

> 命令定义建议放**全局配置**（`~/.config/opencode/opencode.jsonc`），否则只在定义了命令的项目目录会话中可用。

### 方式二：安装脚本

```bash
chmod +x install.sh && ./install.sh
```

脚本会把插件复制到 `~/.config/opencode/plugins/opencode-task-checker/`，并用 Python 更新全局配置的 `plugin` 与 `command` 字段（自动去重）。

### 方式三：npm 安装本地 tgz（仅安装依赖，仍需配置声明）

```bash
npm install /path/to/opencode-task-checker-1.0.3.tgz
```

> 注意：`npm install` 只把包装进 `node_modules`，opencode **不会**用它解析裸字符串插件。**仍需按方式一的 `file://` 声明**，或把解压出的目录作为 `file://` 目标。

### 4. 重启 OpenCode

```bash
systemctl --user restart opencode.service   # 或按你的部署方式重启
```

重启后日志应出现 `[task-checker] [INFO] Task checker plugin configuration loaded.`，可验证加载成功。

## 交互命令

| 命令 | 说明 |
|------|------|
| `/jiance` | 开启当前会话的 3 分钟任务状态监测 |
| `/jiance-off` | 关闭当前会话的任务状态检测，释放后台计时器 |
| `/jiance-s` | 查询当前会话的监测剩余时间与累计时间 |

## 工作原理

1. 用户发送 `/jiance` 后，插件通过 `command.execute.before` 钩子拦截指令（TUI 命令路径），或 `chat.message` 钩子兜底，开启计时器
2. 每 5 秒轮询一次，当会话空闲且距上次交互超过 3 分钟时，自动发送确认 Prompt
3. LLM 回复包含"已完成"或"遇到不可抗力"时，插件自动终止任务
4. 用户发送新任务时，计时器自动重置

## 故障排查

| 现象 | 原因 | 处理 |
|------|------|------|
| `/jiance` 无反应，被当普通文本回复 | 插件未加载（多为裸字符串声明导致 npm 404） | 改用 `file://` 声明；`grep TASK-CHECKER-TEST ~/.local/share/opencode/log/opencode.log` 确认加载 |
| 命令不存在 | command 定义只在项目配置，会话目录不匹配 | 把 command 定义移到全局配置 |
| 加载两次 | 全局与项目配置都声明了同一插件 | 只保留全局一份 |