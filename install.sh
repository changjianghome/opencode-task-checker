#!/usr/bin/env bash
# opencode-task-checker 一键安装脚本
# 用法: ./install.sh  或  ./install.sh /自定义/配置/路径.json
#
# 兼容 OpenCode V1(>=1.18.29) 与 V2(>=2.0)。
# 注意：V2 起命令由插件自带（command.transform），不再需要写 command.jiance*；
#      若你的配置里残留 V1 的 command.jiance*，请手动删除（配置命令优先级更高）。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_NAME="opencode-task-checker"
CFG_DIR="${HOME}/.config/opencode"
PLUGIN_DIR="${CFG_DIR}/plugins/${PLUGIN_NAME}"

echo "==> 1/3 复制插件文件到 ${PLUGIN_DIR}"
mkdir -p "${PLUGIN_DIR}/dist"
cp -f "${SCRIPT_DIR}/dist/index.js" "${PLUGIN_DIR}/dist/index.js"
# 入口必须是自包含构建产物：相对 re-export 会在热重载时命中模块缓存
cp -f "${SCRIPT_DIR}/dist/index.js" "${PLUGIN_DIR}/index.js"
cp -f "${SCRIPT_DIR}/package.json"  "${PLUGIN_DIR}/package.json"
PLUGIN_SPEC="file://${PLUGIN_DIR}"

# 定位全局配置文件
if [ $# -ge 1 ] && [ -n "$1" ]; then
  CFG_FILE="$1"
elif [ -f "${CFG_DIR}/opencode.json" ]; then
  CFG_FILE="${CFG_DIR}/opencode.json"
elif [ -f "${CFG_DIR}/opencode.jsonc" ]; then
  CFG_FILE="${CFG_DIR}/opencode.jsonc"
else
  CFG_FILE="${CFG_DIR}/opencode.json"
fi

echo "==> 2/3 更新全局配置 ${CFG_FILE}（plugin 字段，自动去重）"
python3 - "${CFG_FILE}" "${PLUGIN_SPEC}" << 'PYEOF'
import json, re, sys

path, spec = sys.argv[1], sys.argv[2]
raw = open(path, encoding="utf-8").read()

# 简易 JSONC -> JSON：去掉行注释与块注释
stripped = re.sub(r'/\*.*?\*/', '', raw, flags=re.S)
stripped = re.sub(r'^\s*//.*$', '', stripped, flags=re.M)

data = json.loads(stripped)

# V2 接受 plugins；V1 使用 plugin。优先沿用文件中已有的键，避免混用。
key = "plugins" if ("plugins" in data and "plugin" not in data) else "plugin"
plugins = data.get(key, [])
if not isinstance(plugins, list):
    plugins = []
if spec not in plugins:
    plugins.append(spec)
data[key] = plugins

with open(path, "w", encoding="utf-8") as f:
    json.dump(data, f, ensure_ascii=False, indent=2)
    f.write("\n")
PYEOF

echo "==> 3/3 校验配置"
python3 - "${CFG_FILE}" << 'PYEOF'
import json, re, sys
raw = open(sys.argv[1], encoding="utf-8").read()
stripped = re.sub(r'/\*.*?\*/', '', raw, flags=re.S)
stripped = re.sub(r'^\s*//.*$', '', stripped, flags=re.M)
d = json.loads(stripped)
print("plugin :", d.get("plugin"))
print("plugins:", d.get("plugins"))
print("command:", list(d.get("command", {}).keys()) or None)
PYEOF

echo "==> 完成"
echo "插件已安装到: ${PLUGIN_DIR}"
echo "已在 ${CFG_FILE} 声明: ${PLUGIN_SPEC}"
echo "请重启 opencode 使配置生效，例如: opencode service restart"
