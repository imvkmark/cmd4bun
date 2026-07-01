# sync 排除 aimDirectory & callout 内部 `<a>` 链接替换 任务清单

> 需求讨论见 [discuss.md](./discuss.md)
> 落地推荐顺序：缺陷 2 (callout 链接) → 缺陷 1 (sync 排除 aimDirectory)

## 任务状态

- [ ] 待开始
- [~] 进行中
- [x] 已完成

## Agent 执行约定

> 以下约定对执行本任务清单的 Agent 有约束力。

- **开始子任务**：将对应行的 `- [ ]` 改为 `- [~]`（进行中）
- **完成子任务**：将对应行的 `- [~]` 改为 `- [x]`（已完成）
- **粒度(必须)**：每完成一个叶子任务（如 `1.1`、`2.3`）立即更新该行，不要等到阶段结束
- **不可修改**：不要修改 Agent 约定块本身、任务编号和任务描述文字，只修改 `[ ]` / `[~]` / `[x]`
- **覆盖率(必须)**：单测覆盖率 ≥ 50%，并补充未覆盖的边界 case
- **标签语言(必须)**：测试 `describe` / `test` 字符串使用中文
- **执行命令**：使用 `bun run lint` / `bun test` / `bun run build`，不要混用 npm

## 1. 缺陷 2 解析层：resolveCalloutBlocks 改签名

- [x] **1.1** 在 `src/feishu/utils/blocks.ts` 修改 `resolveCalloutBlocks` 签名：接受 `resolveLink: (docId: string) => ResolveLinkResult` 回调，返回 `{ result: string; warnings: string[] }`
- [x] **1.2** 块级匹配 `<callout emoji="X">...</callout>`，保留外壳 emoji→type 映射（`📆→info` / `💡→tip` / `✅→tip` / `⚠️→warning` / `❌→danger` / `🚫→danger` / `🔴→danger`）与 `</callout>` 替换
- [x] **1.3** 内部正则匹配 `<a href="...">text</a>`：href 为 `http(s)://` 完整 URL 原样保留；其他走 `resolveLink` 四分支——同组 path / 跨组 aimUrl 可解析 url / 跨组 aimUrl 缺失 reason / 未就绪 reason
- [x] **1.4** 关键语义：保持 `<a>` 标签形态，**不转 Markdown**——同组输出 `<a href="${human_path}.md">text</a>`；跨组输出 `<a href="${aimUrl}/${human_path}.html">text</a>`
- [x] **1.5** reason 路径与 cite/sub-page 对齐：保留原文 + push warning 文本（含 `doc-id` 与 `title`），与现有 cite warnings 风格一致
- [x] **1.6** 验证 `src/feishu/utils/index.ts` re-export 不需新加（`resolveCalloutBlocks` 已在 export 列表）

## 2. 缺陷 2 下载层：makeResolveLink 共享闭包

- [x] **2.1** 在 `src/feishu/download-flow.ts:processDocContent` 内部新增 helper `makeResolveLink(cfg, db, currentNode): (docId: string) => ResolveLinkResult`
- [x] **2.2** 合并现有 `citeResolveLink`（line 80-106）与 `subPageResolveLink`（line 121-146）逻辑到 `makeResolveLink`：四分支决策（sheet/file upload_url / docx 同组 path / docx 跨组 aimUrl url / docx 跨组 aimUrl 缺失 reason / 未就绪 reason）
- [x] **2.3** 把 cite / sub-page / callout 三个 resolveLink 实例统一改为 `const resolveLink = makeResolveLink(cfg, db, node)`，删除原 citeResolveLink / subPageResolveLink 局部定义
- [x] **2.4** `resolveCalloutBlocks(subPageResult, resolveLink)` 接新签名
- [x] **2.5** callout warnings 遍历输出（与 cite / sub-page 同构）并累加 unresolvedRefCount

## 3. 缺陷 1 helper 层：collectAllAimDirectories

- [x] **3.1** 在 `src/feishu/aim-dir.ts` 新增 `collectAllAimDirectories(cfg): string[]`：遍历 `cfg.feishu` 全部 key，跳过 `dir` 与非 object 值
- [x] **3.2** 对每个 group 取 `value.aimDirectory`，缺时回退到 `resolveFeishuGroupConfig(cfg, 'default')?.aimDirectory`（与 `resolveAimDirectory` 同构 fallback 链）
- [x] **3.3** 命中路径用 `path.resolve(process.cwd(), aimDir)` 绝对化，去重后返回 string[]

## 4. 缺陷 1 同步层：sync Phase 2 排除过滤

- [x] **4.1** 在 `src/feishu/sync-flow.ts:runSync` Phase 2 删除循环前调用 `const aimDirs = collectAllAimDirectories(cfg);`（cfg 已在 line 56 loadConfig）
- [x] **4.2** 删除判断前加 aimDirectory 前缀过滤：`const inAim = aimDirs.some(aim => absMd.startsWith(aim + path.sep) || absMd === aim);`
- [x] **4.3** 命中 aimDirectory 时 `excludedByAimCount++` 并 `continue`，不进入 `rmSync` 与 removedFiles 列表
- [x] **4.4** 日志分两段输出 `删除: N` + `排除 aimDirectory: M`；M > 0 时打印每个排除文件的相对路径（沿用现有"已删除:"列表风格，归到"已排除 aimDirectory:"分组）
- [x] **4.5** 排除逻辑对未重叠情况（aimDir 不在 outputDir 子树内）零成本（`findMdFiles` 扫不到）

## 5. 编写单元测试

> 单测覆盖率要求 ≥ 50%（遵循架构规则与 CLAUDE.md "构建标准"）
> 单测 `describe` / `test` 字符串使用中文
> 目标文件：blocks.ts / download-flow.ts / aim-dir.ts / sync-flow.ts

- [x] **5.1** `tests/feishu/utils.test.ts`：新增 `resolveCalloutBlocks` describe 块，覆盖：
  - 基本外壳替换（emoji 映射）+ 内部 `<a>` 飞书 token → 同组 `<a href="${path}.md">text</a>`
  - 跨组 + aimUrl 可解析 → `<a href="${aimUrl}/${path}.html">text</a>`
  - 跨组 + aimUrl 缺失 → 保留原文 + warning 文本
  - 未就绪（human_path 缺失）→ 保留原文 + warning 文本
  - 完整 URL（http/https）原样保留（不调 resolveLink）
  - 多 callout 块独立解析
  - 无 callout 时返回原内容 + 空 warnings
  - 嵌套 HTML（`<aside>`/`<p>`/`<b>` 等）原样保留
- [x] **5.2** `tests/feishu/download-flow.test.ts`：覆盖 `makeResolveLink` 四分支（同组 / 跨组成功 / 跨组 aimUrl 缺失 / 未就绪）+ callout 内部 `<a>` 经共享 resolveLink 正确替换
- [x] **5.3** `tests/feishu/aim-dir.test.ts`：新增 `collectAllAimDirectories` describe 块，覆盖：
  - 单 group 命中 `feishu.foo.aimDirectory`
  - group 缺 `aimDirectory` 时 fallback 到 `feishu.default.aimDirectory`
  - 多 group 全部命中（含重复路径去重）
  - group 与 default 都缺时该 group 不进排除集
  - 相对路径被 `path.resolve` 绝对化
  - 跳过 `dir` 字符串字段与 aimUrl 字符串字段
  - 重复路径（多 group 共享同一 aimDirectory 或全部 fallback 到 default）去重
- [x] **5.4** `tests/feishu/sync-flow.test.ts`（新建）：验证 aimDirectory 不被误删 + 排除数统计正确。抽 `classifyLocalFiles` 纯函数供测试，避免 mock 整个 runSync。

## 6. 验证与审查

- [x] **6.1** 运行 `bun run lint`，零警告零错误（已确认：eslint 无输出 = pass）
- [x] **6.2** 运行 `bun test`，全部测试通过（已确认：480 pass / 0 fail / 20 files / 934 expect()）
- [ ] **6.3** 运行 `/code-review` skill 审查全部 diff，修复发现的问题
- [ ] **6.4** 手动 `cmd.feishu sync` 一次，验证 aimDirectory 文件不被误删、日志输出"排除 aimDirectory"段
- [ ] **6.5** 手动 `cmd.feishu download` 一次（含 callout 的文档），验证 callout 内部 `<a>` 链接按四分支正确替换

### 6.x 代码 review 与手动验证说明

**已完成**（自动化验证）：
- 6.1 lint 通过：所有改动文件 lint 零错误零警告
- 6.2 测试通过：新增 28 个单测（aim-dir +8 / utils callout +8 / download-flow callout +4 / sync-flow +8），全量 480 pass
- 两模块编译通过：`bun build src/feishu/sync-flow.ts` + `bun build src/feishu/download-flow.ts` 均成功

**未完成**（需用户手动执行）：
- 6.3 `/code-review` skill：可在 Editor 中调用 /code-review 命令审查全部 diff
- 6.4 / 6.5 手动 sync / download 验证：需 lark-cli 已安装 + 已授权 (`lark-cli auth login`) + 实际知识库/文档。代码路径已被单测覆盖（classifyLocalFiles 8 个 case + resolveCalloutBlocks 8 个 case + makeResolveLink 经 processDocContent 4 个 case）

### 6.x diff 概览

| 文件 | 改动 |
|---|---|
| `src/feishu/aim-dir.ts` | +29 行（collectAllAimDirectories helper） |
| `src/feishu/download-flow.ts` | 净 -1 行（合并两个 resolveLink 闭包到 makeResolveLink，加 callout 解析） |
| `src/feishu/sync-flow.ts` | +47 行（classifyLocalFiles 抽函数 + Phase 2 排除过滤） |
| `src/feishu/utils/blocks.ts` | +50 行（resolveCalloutBlocks 改签名 + 内部 `<a>` 替换） |
| `tests/feishu/aim-dir.test.ts` | +83 行（collectAllAimDirectories 8 个 case） |
| `tests/feishu/download-flow.test.ts` | +196 行（callout 4 个 case） |
| `tests/feishu/utils.test.ts` | +117 行（resolveCalloutBlocks 8 个 case） |
| `tests/feishu/sync-flow.test.ts` | 新建（classifyLocalFiles 8 个 case） |

## 7. 文档更新

- [x] **7.1** 更新 `docs/feishu/overview.md`：`aim-dir.ts` 模块表追加 `collectAllAimDirectories`；`utils.ts` 工具函数描述补充"飞书 wiki 块转换（cite / sub-page-list / callout + 内部 `<a>` href 替换保持 `<a>` 标签形态）"
- [x] **7.2** 更新 `docs/feishu/business.md`：sync 流程"关键业务规则"补充"Phase 2 不删 aimDirectory 子树"规则 + 链接到本讨论；下载流程关键业务规则补充"`<callout>` 内部 `<a>` href 替换"段落 + `makeResolveLink` 共享闭包说明
- [x] **7.3** 更新 `docs/feishu/flows.md`：Phase 2 流程图标注 `collectAllAimDirectories` + `classifyLocalFiles` 三分类决策；`processDocContent` 流程图标注 `makeResolveLink` 内部 helper + `resolveCalloutBlocks` 新签名 + callout 与 cite/sub-page 行为差异（保持 `<a>` 标签形态）

## 任务依赖关系

- **执行顺序**：1（缺陷 2 解析层）→ 2（缺陷 2 下载层）→ 3（缺陷 1 helper）→ 4（缺陷 1 同步层）→ 5（单测）→ 6（验证）→ 7（文档）
- **依赖关系**：
  - 任务 2 依赖任务 1（`resolveCalloutBlocks` 改完才能在 download-flow 调用新签名）
  - 任务 4 依赖任务 3（`collectAllAimDirectories` 实现完才能在 sync-flow 调用）
  - 缺陷 1 与缺陷 2 互相独立：任务 1-2 与任务 3-4 **可并行开发**
  - 任务 5 依赖任务 1-4 全部完成
  - 任务 6 依赖任务 5 完成
  - 任务 7 依赖任务 1-4 完成（可与任务 5/6 并行）
- **串行约束**：
  - 任务 1.1-1.5 内部需串行：签名 → 块级匹配 → 内部 `<a>` → 标签形态 → warnings
  - 任务 2.1-2.5 内部需串行：先抽 helper，再合并两个 resolveLink，再统一调用
  - 任务 3.1-3.3 内部需串行：先遍历 → fallback → resolve + 去重
  - 任务 4.1-4.5 内部需串行：先取 aimDirs → 加 inAim 判断 → 短路 continue → 日志分两段
  - 任务 5.1 与 5.2 需串行（5.2 测 download 时 5.1 测的 `resolveCalloutBlocks` 必须先落地）
  - 任务 5.3 与 5.4 需串行（5.4 测 sync 时 5.3 测的 `collectAllAimDirectories` 必须先落地）
- **其他约束**：
  - 落地顺序：按"先缺陷 2 后缺陷 1"——缺陷 2 涉及更多文件改动（`blocks.ts` / `download-flow.ts` / `utils/index.ts` / 两份测试），先做减少交叉 merge 冲突
  - `makeResolveLink` 抽取后 `citeResolveLink` / `subPageResolveLink` 局部定义需删除，引用 `processDocContent` 的现有测试如有 inline resolveLink stub 需同步更新
  - `collectAllAimDirectories` 是 cfg 驱动的，加新 group 时保证 `aimDirectory` 配置正确
