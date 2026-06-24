# Git 提交辅助业务逻辑

## 状态机

```text
HAS_CHANGES → GENERATED → CONFIRMING → COMMITTED
              ↘ REGENERATED ───┘
              ↘ MODIFIED ──────┘
              ↘ CANCELLED
NO_CHANGES → EXITED
```

状态说明：

- `NO_CHANGES` 直接结束：避免生成没有实际提交对象的提交说明。
- `GENERATED` 后必须进入人工确认：提交信息由 AI 生成，但最终提交动作需要用户确认。
- `REGENERATED` 与 `MODIFIED` 回到确认前状态：允许用户在提交前修正 AI 输出。
- `CANCELLED` 随时可退出：交互式 CLI 需要保留用户中止能力。

## 关键业务规则

- 提交前必须展示变更摘要：用户需要在确认提交说明前看到本次提交覆盖的文件范围，降低误提交风险。
- AI 建议不能直接自动落地：`.gitignore` 建议和提交说明都需要用户可见，避免模型误判导致项目文件被错误忽略或提交说明偏离真实变更。
- 优先基于已暂存 diff 生成说明：当存在 staged 内容时，提交意图通常以暂存区为准；没有 staged diff 时才使用未暂存 diff。
- 提交命令参数需要隔离传递：提交说明属于动态文本，应避免通过 shell 字符串拼接传入命令。
- Accept 路径提交前进入文件多选：已暂存文件默认选中且不可取消，未暂存和未跟踪文件由用户选择后再暂存。
- Modify 路径保留 `git add -A` 行为：用户手动修改提交说明后，全量暂存当前工作区再提交。

## 配置优先级

- DeepSeek token 来源：`CMD_BUN_DEEPSEEK_TOKEN` 环境变量 > `config.json` 中 `deepseek.token` 字段。
- 配置文件路径：`$XDG_CONFIG_HOME/cmd4bun/config.json`，未设置 `XDG_CONFIG_HOME` 时回退 `~/.config/cmd4bun/config.json`。
- 旧环境变量 `CMD_BUN_DEEKSEEK_TOKEN` 不再支持。
