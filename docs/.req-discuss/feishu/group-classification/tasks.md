# group-classification 任务清单

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

## 1. 解析层改造

- [x] **1.1** 在 `src/feishu/utils/markdown.ts` 中扩展 `parseFrontmatterMeta` / `parseAndStripFrontmatter` 返回值,新增 `group: string` 字段;新增正则 `/^group[^\S\n]*:[^\S\n]*(.+)$/m`,trim 后校验 `[a-z0-9-]+`,校验失败或缺失返回 `'default'`;`parseAndStripFrontmatter` 剥离条件追加 `group`
- [x] **1.2** 在 `src/feishu/utils/index.ts` 确认 `parseFrontmatterMeta` / `parseAndStripFrontmatter` 导出签名同步生效

## 2. 存储层改造

- [x] **2.1** 新增迁移文件 `src/feishu/migrations/016_add_group.sql`:`ALTER TABLE nodes ADD COLUMN group TEXT NOT NULL DEFAULT 'default';`
- [x] **2.2** 在 `src/feishu/db.ts` 中 `DBNode` 接口新增 `group: string` 字段;新增 `updateNodeGroup(db, nodeToken, group: string)` 函数

## 3. 同步层改造

- [x] **3.1** 修改 `src/feishu/sync-flow.ts` 的 `upsertNodeStmt`:`INSERT INTO nodes` 列清单追加 `group`,VALUES 同步加 `$group`,值固定为 `'default'`;`ON CONFLICT(node_token) DO UPDATE SET` **不**包含 `group`(沿用 is_ignore 模式,保留作者已设置的 group)
- [x] **3.2** 修改 `upsertNodeStmt.run({...})` 调用,传入 `$group: 'default'`

## 4. 配置层改造

- [x] **4.1** 修改 `src/config.ts`:`FeishuConfig` 改为 `dir?: string` + `default?: FeishuGroupConfig` + 索引签名 `[group: string]: FeishuGroupConfig | string | undefined`;新增 `FeishuGroupConfig { aimDirectory?: string; aimUrl?: string }`;删除顶层 `aimDirectory` / `aimUrl`
- [x] **4.2** 新增 `resolveFeishuGroupConfig(cfg: AppConfig, group: string): FeishuGroupConfig | null` 助手函数:命中 `feishu.{group}` 返回该对象,否则返回 `null`
- [x] **4.3** 修改 `loadConfig`:检测到老的 `feishu.aimDirectory` / `feishu.aimUrl` 字段时打 stderr 警告并提示迁移到 `feishu.default.*`

## 5. 下载层改造

- [x] **5.1** 修改 `src/feishu/download-flow.ts` 的 `processDocContent`:解构 `group` 后无条件调用 `updateNodeGroup(db, node.node_token, group)`;校验失败降级时 `console.warn` 一行提示作者
- [x] **5.2** 修改 `processDocContent` 中 `buildFrontmatter` 调用:`aimUrl` 改为 `cfg.feishu?.[node.group]?.aimUrl ?? cfg.feishu?.default?.aimUrl`(从 node 当前 group 取)
- [x] **5.3** 修改下载 3380003 错误清理分支:用 `node.group` 查 `resolveFeishuGroupConfig(cfg, node.group)?.aimDirectory`,fallback 到 `resolveFeishuGroupConfig(cfg, 'default')?.aimDirectory`,再找不到则跳过 aimDirectory 副本清理(仅清理本地 `.md` + DB 行)

## 6. CLI 层改造

- [x] **6.1** 在 `src/feishu/cli/types.ts` 新增 `CopyDocsArgs extends CommonArgs { group: string }`(默认空字符串);`ParsedCommand` 联合分支 `'copy-docs'` 改用 `CopyDocsArgs`
- [x] **6.2** 在 `src/feishu/cli/registry.ts` 中 `'copy-docs'` 的 `buildArgs` 返回 `{ ...common, group: '' }`;flags 新增 `--group, -g`(takesValue=true,apply 写入 `args.group`);`run` 类型签名改为 `CopyDocsArgs`
- [x] **6.3** 修改 `src/feishu/cli/parse-args.ts` 中 `AnyArgs` 联合添加 `CopyDocsArgs`;`case 'copy-docs'` 分支用 `CopyDocsArgs` 精确断言

## 7. 复制层改造

- [x] **7.1** 修改 `src/feishu/copy-docs-flow.ts` 的 `runCopyDocs` 签名接收 `CopyDocsArgs`(而不是 `CommonArgs`)
- [x] **7.2** 实现 `--group` 指定分支:SQL 增加 `AND group = ?`;通过 `resolveFeishuGroupConfig(cfg, args.group)` 读 aimDirectory,fallback 到 `default`,都未配置时报错退出
- [x] **7.3** 实现 fan-out 分支(args.group 为空时):`SELECT DISTINCT group FROM nodes WHERE <现有复制条件> ORDER BY group`;对每个 group 串行执行复制,缺 aimDirectory 的 group `console.log` 警告并跳过
- [x] **7.4** 复制函数内部提取 `copyDocsForGroup(db, outputDir, group, aimDirectory, isFanOut): Promise<{copied, skipped}>` 子函数,避免 fan-out 与单 group 分支重复实现
- [x] **7.5** 更新提示文案:单 group "目标 group 没有可复制文档";fan-out 模式按 group 单独统计;整体无文档 "没有符合复制条件的文档"

## 8. 编写单元测试

> 单测覆盖率要求 ≥ 50%(遵循架构规则)
> 单测标签使用中文(如 `describe('解析 group 字段', ...)`)
> 其他要求:覆盖 group 校验失败降级、fan-out 跳过 warn、老配置 stderr 警告、覆盖写语义

- [x] **8.1** 在 `tests/feishu/utils.test.ts` 中追加 `parseFrontmatterMeta` / `parseAndStripFrontmatter` 的 group 字段用例:合法小写名、缺失字段、非法字符(大写/中文/含路径字符)、与 slug/ignore 共存触发剥离
- [x] **8.2** 在 `tests/config.test.ts`(若不存在则新建)中追加 `resolveFeishuGroupConfig` 与 `loadConfig` 老配置警告用例:命中 default、未命中 group、检测到老 aimDirectory/aimUrl 打 stderr
- [x] **8.3** 在 `tests/feishu/copy-docs-flow.test.ts` 中(若不存在则新建)追加 fan-out 与 --group 分支用例:DB 含多 group、缺 aimDirectory 跳过 + warn、--group 仅过滤单 group、空 DB 提示
- [x] **8.4** 在 `tests/feishu/db.test.ts`(若不存在则新建)追加 `updateNodeGroup` 覆盖写用例,验证迁移文件 `016_add_group.sql` 默认值生效

## 9. 验证与审查

- [x] **9.1** 运行 `bun run lint --fix` 确保代码风格通过
- [x] **9.2** 运行 `bun test` 全部测试通过,核对覆盖率 ≥ 50%
- [~] **9.3** 运行 `/code-review` skill 审查全部 diff,修复发现的问题(由用户在交互中触发)

## 10. 文档更新

- [x] **10.1** 更新 `docs/feishu/overview.md`:`nodes` 表 schema 新增 `group` 列说明;`config.json` 示例改为新结构(`feishu.default.aimDirectory` / `feishu.default.aimUrl` + 可选 group 对象);字段说明表格同步
- [x] **10.2** 更新 `docs/feishu/business.md`:在"飞书文档下载"章节追加 `group` 字段解析规则(校验、默认值、降级);复制文档章节说明 fan-out 行为与配置要求;配置优先级段落改用 `feishu.default.*`
- [x] **10.3** 更新 `docs/feishu/flows.md`:下载流程图标注 `group` 解析点;新增"按 group fan-out 复制"流程图;3380003 删除清理分支标注 aimDirectory 按节点 group 查找
- [x] **10.4** 更新 `docs/feishu/overview.md` 的"开发约定与后续建议"段落:补充"新增 frontmatter 字段时,需在解析器、DB 列、下载覆盖写、文档同步更新四点同时演进"

## 任务依赖关系

- **执行顺序**:1 (解析) → 2 (存储) → 3 (同步) → 4 (配置) → 5 (下载) → 6 (CLI) → 7 (复制) → 8 (测试) → 9 (验证) → 10 (文档)
- **依赖关系**:
  - 2.x 依赖 1.x(存储层接口要消费解析层的 group 字段)
  - 3.x 依赖 2.x(同步层 INSERT 要包含 group 列)
  - 5.x 依赖 4.x(下载层要使用 `resolveFeishuGroupConfig`)
  - 6.x 依赖 2.x(CLI 类型要引用 CopyDocsArgs,CopyDocsArgs 在 types.ts 中定义,独立完成)
  - 7.x 依赖 4.x + 6.x(复制层使用配置助手 + CLI 参数)
  - 8.x 依赖 1-7.x 全完成
  - 9.x 依赖 8.x
  - 10.x 依赖 9.x(确保代码定型后再写文档)
- **可并行项**:
  - 1.x 与 2.1(迁移文件)可并行,但 2.2(DBNode 接口)需 1.x 完成
  - 4.1(类型重构)与 4.2(解析助手)可串行,4.3(警告)可与 4.1/4.2 并行
  - 6.x(CLI 层)与 7.x(复制层)在 7.1 之前可并行准备
- **其他约束**:
  - 解析层单测必须先于其他层(1.1 → 8.1 串行)
  - 配置层重构(4.x)是其他层的横切依赖,需尽早完成
  - 文档(10.x)必须等代码 review 通过后写,避免与最终实现不一致