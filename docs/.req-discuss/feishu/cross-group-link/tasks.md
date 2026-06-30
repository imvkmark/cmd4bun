# cross-group-link 任务清单

## 任务状态

- [ ] 待开始
- [~] 进行中
- [x] 已完成

## Agent 执行约定

> 以下约定对执行本任务清单的 Agent 有约束力。

- **开始子任务**：将对应行的 `- [ ]` 改为 `- [~]`（进行中）
- **完成子任务**：将对应行的 `- [~]` 改为 `- [x]`（已完成）
- **粒度(必须)**：每完成一个叶子任务（如 `1.1`、`2.3`）立即更新该行，不要等到阶段结束
- **不可修改**：不要修改 Agent 约定块本身、任务编号和任务描述文字，只修改 `[ ]` / `[~]` / `[x]` 状态标记

## 1. 类型层改造

- [x] **1.1** 在 `src/feishu/utils/blocks.ts` 扩展 `ResolveLinkResult` 类型为三态 `{ path: string } | { url: string } | { reason: string }`,与现有 `{ reason }` 平行
- [x] **1.2** 修改 `resolveCiteBlocks` 输出端:增加 `url` 分支返回 `\`[${title}](${linkResult.url})\``(不加 `.md`),保留现有 `path` 分支与 `reason` 分支
- [x] **1.3** 修改 `resolveSubPageListBlocks` 输出端:同步增加 `url` 分支,返回 `- [${title}](${linkResult.url})`,保留 `path` / `reason` 分支

## 2. helper 层改造

- [x] **2.1** 在 `src/feishu/aim-dir.ts` 新增 `resolveAimUrl(cfg: AppConfig, group: string): string | null`,与 `resolveAimDirectory` 对称:fallback 链为 `feishu.{group}.aimUrl ?? feishu.default.aimUrl ?? null`,复用 `resolveFeishuGroupConfig` 实现

## 3. 下载层改造

- [x] **3.1** 在 `src/feishu/download-flow.ts` 的 `processDocContent` 函数顶部增加 `const cfg = await loadConfig();`(从原 `:149` 提前),让后续 `resolveLink` 闭包可访问 cfg
- [x] **3.2** 重写 cite 的 `citeResolveLink` 闭包(原 line 62-79)为四种分支:sheet/file + upload_url → `{ url: upload_url }`;docx + human_path + 同组(`refNode.group === currentGroup`) → `{ path: human_path }`;docx + human_path + 跨组 + `resolveAimUrl(cfg, refNode.group)` 可解析 → `{ url: \`${aimUrl.replace(/\/+$/, '')}/${refNode.human_path.replace(/^\/+/, '')}.html\` }`;docx + human_path + 跨组 + aimUrl 不可解析 → `{ reason: \`cross-group 引用目标 group "${refNode.group}" 缺少 aimUrl 配置\` }`;未就绪分支(human_path/upload_url 缺失)保留 `{ reason }`
- [x] **3.3** 移除 cite 的 `citeResolveLink` 内 `incrementNodePriority(db, docId)` 与 `markNodeDownloaded(db, docId, null)` 两处调用
- [x] **3.4** 重写 sub-page 的 `subPageResolveLink` 闭包(原 line 100-117)与 cite 同构,使用 `getNodeByObjToken` 取 `refNode`,覆盖四种分支
- [x] **3.5** 移除 sub-page 的 `subPageResolveLink` 内 `incrementNodePriority` 与 `markNodeDownloaded` 两处调用

## 4. 编写单元测试

> 单测覆盖率要求 ≥ 50%(遵循架构规则)
> 单测标签使用中文(如 `describe('跨组引用解析', ...)`)
> 其他要求:覆盖三态转换、同组 vs 跨组、aimUrl 命中/缺失/fallback 三路径、bump 移除验证

- [x] **4.1** 在 `tests/feishu/utils.test.ts` 中追加 `resolveCiteBlocks` / `resolveSubPageListBlocks` 的 `ResolveLinkResult` 三态用例:`{path}` → 输出追加 `.md`;`{url}` → 输出不加 `.md`(sheet/file 与跨组两种来源都覆盖);`{reason}` → 输出原文 + warning
- [x] **4.2** 在 `tests/feishu/aim-dir.test.ts` 中追加 `resolveAimUrl` 单测:命中 group 自有 aimUrl、命中但 fallback 到 default、双未配返回 null、default 自身命中
- [x] **4.3** 在 `tests/feishu/download-flow.test.ts` 中追加 `processDocContent` 引用解析四种分支用例(各覆盖 cite 与 sub-page):同组 → 相对 `.md`;跨组 + aimUrl 命中 → 绝对 URL;跨组 + aimUrl 缺失 → 原文 + warning;未就绪(human_path/upload_url 缺失)→ 原文 + warning 且不调用 `incrementNodePriority`/`markNodeDownloaded`

## 5. 验证与审查

- [x] **5.1** 运行 `bun run lint --fix` 确保代码风格通过
- [x] **5.2** 运行 `bun test` 全部测试通过,核对覆盖率 ≥ 50%
- [ ] **5.3** 运行 `/code-review` skill 审查全部 diff,修复发现的问题(由用户在交互中触发)

## 6. 文档更新

- [x] **6.1** 更新 `docs/feishu/overview.md`:`aim-dir.ts` 模块表追加 `resolveAimUrl` 行(职责:按 group 名解析 aimUrl,fallback 到 default)
- [x] **6.2** 更新 `docs/feishu/business.md`:`<cite>` / `<sub-page-list>` 解析业务规则段落补充"跨 group 引用 → 绝对 aimUrl(.html 后缀)"与"未配置 aimUrl 走原文 + warning"两条规则;说明 resolveLink 闭包内不再 bump priority
- [x] **6.3** 更新 `docs/feishu/flows.md`:`processDocContent` 流程图标注 resolveLink 的四种分支与 cfg 提前到函数顶部

## 任务依赖关系

- **执行顺序**:1 (类型) → 2 (helper) → 3 (下载) → 4 (测试) → 5 (验证) → 6 (文档)
- **依赖关系**:
  - 3.x 依赖 1.x + 2.x(下载层 resolveLink 闭包依赖 `ResolveLinkResult` 三态与 `resolveAimUrl` helper)
  - 4.x 依赖 1.x + 2.x + 3.x 全完成(测试要覆盖最终实现)
  - 5.x 依赖 4.x
  - 6.x 依赖 5.x(确保代码 review 通过、行为定型后再写文档)
- **可并行项**:
  - 1.x 内部:1.1(类型扩展)与 1.2/1.3(调用方更新)必须串行——先扩类型才能改调用方
  - 2.1(aim-dir.ts 新增 helper)与 1.x(类型层)无相互依赖,可并行,但 2.1 完成后才能在 3.x 中调用
- **其他约束**:
  - 类型层(1.x)单测必须先于其他层完成(`bun test tests/feishu/utils.test.ts` 通过再进入 3.x)
  - helper 层(2.x)单测独立路径,完成后才能在 3.x 中调用
  - 文档(6.x)必须等 code-review 通过后写,避免与最终实现不一致
  - 不改 DB schema、不改 config.ts 导出(新增 helper 全部在 `src/feishu/aim-dir.ts` 内)