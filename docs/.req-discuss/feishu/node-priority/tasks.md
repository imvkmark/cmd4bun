# node 优先级 任务清单

> 基于 `discuss.md` 方案 A 拆解。所有路径相对仓库根目录 `/Users/duoli/Projects/duoli-wulicode/cmd4bun`。

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

## 1. 数据库迁移

- [x] **1.1** 新建 `src/feishu/migrations/011_add_node_priority.sql`
  - 内容：`ALTER TABLE nodes ADD COLUMN priority INTEGER NOT NULL DEFAULT 0;`
  - 依赖 `init-db-flow.ts` 已有的 duplicate column 幂等机制，无需额外防护

## 2. DB 层改造（`src/feishu/db.ts`）

- [x] **2.1** `DBNode` 接口（`src/feishu/db.ts:11-28`）新增 `priority: number` 字段
- [x] **2.2** 新增函数 `incrementNodePriority(db, nodeToken): void`
  - 实现：`db.run('UPDATE nodes SET priority = priority + 1 WHERE node_token = ?', [nodeToken])`
  - 单行 UPDATE；nodeToken 不存在时影响 0 行，不抛错
- [x] **2.3** `getDownloadQueue`（`src/feishu/db.ts:141-150`）SQL 末尾追加 `ORDER BY priority DESC, node_token ASC`

## 3. download 阶段改造（`src/feishu/download-flow.ts`）

- [x] **3.1** 顶部 import 加入 `incrementNodePriority`
- [x] **3.2** `processDocContent`（`src/feishu/download-flow.ts:36-42`）callback 改造为三分支
  - ① `refNode === null` → 返回 `null`（不 +1）
  - ② `refNode.human_path` 非空 → 返回 `refNode.human_path`
  - ③ `refNode` 存在且 `human_path` 为空 → `incrementNodePriority(db, docId)`，返回 `null`

## 4. sync-updated-at 阶段改造（`src/feishu/sync-updated-at-flow.ts`）

- [x] **4.1** 单节点分支 SQL（`src/feishu/sync-updated-at-flow.ts:44-46`）加 `ORDER BY priority DESC, node_token ASC`
- [x] **4.2** 按空间分支 SQL（`src/feishu/sync-updated-at-flow.ts:62-64`）加 `ORDER BY priority DESC, node_token ASC`
- [x] **4.3** 全量分支 SQL（`src/feishu/sync-updated-at-flow.ts:79`）加 `ORDER BY priority DESC, node_token ASC`

## 5. 编写单元测试

> 单测覆盖率要求 ≥ 50%（遵循 `CLAUDE.md` 构建标准）
> 测试模式参考 `tests/feishu/db.test.ts:263-360` `purgeOrphanNodes` 的 `:memory:` SQLite 模式
> 中文 test 标签（`describe` / `test` 名称）

- [x] **5.1** `tests/feishu/db.test.ts` 新增 `describe('incrementNodePriority', ...)` 套件
  - 5.1.1 单次 +1：从 0 升到 1
  - 5.1.2 多次累加：连续 3 次调用从 0 升到 3
  - 5.1.3 不存在的 node_token：UPDATE 影响 0 行，不抛错
  - 5.1.4 已存在的 priority>0：从 5 升到 6
- [x] **5.2** `tests/feishu/db.test.ts` 补充 `getDownloadQueue` 排序行为测试
  - 5.2.1 验证返回结果按 `priority DESC, node_token ASC` 排序
  - 5.2.2 验证 force=true 时不过滤
  - 5.2.3 验证 force=false 时仅返回 `needsDownload=true` 的节点
- [x] **5.3** 确认 `tests/feishu/utils.test.ts:371-483` 的 `resolveCiteBlocks` 测试全部继续通过（callback 签名零变化）
- [ ] **5.3** 确认 `tests/feishu/utils.test.ts:371-483` 的 `resolveCiteBlocks` 测试全部继续通过（callback 签名零变化）

## 6. 验证与代码审查

- [x] **6.1** 运行 `bun run lint`，修复全部 lint 错误
- [x] **6.2** 运行 `bun test`，重点验证 `tests/feishu/db.test.ts` / `tests/feishu/utils.test.ts` / `tests/feishu/download-flow.test.ts` / `tests/feishu/sync-updated-at.test.ts` 全部通过
  - 结果：priority 相关套件 0 失败（含 db.test.ts 新增 7 个）。4 个 pre-existing fail（`images.test.ts` x2 / `db.test.ts:ensureDB` / `init-db.test.ts:迁移幂等执行`）与本次改动无关，由用户其他并行改动（image_vs_node 重命名）引入，已 git stash 验证为预存。
- [x] **6.3** 运行 `bun run build`，确认产物正常
- [x] **6.4** 运行 `/code-review` skill 审查全部 diff，修复发现的问题
  - 结果：1 个 PLAUSIBLE 微改进（`if (refNode.human_path)` truthy → `!== null` 显式比较），已修复。0 CONFIRMED bug。
- [ ] **6.5** （可选）手动 `bun run src/feishu.ts init-db` 验证迁移幂等成功
- [ ] **6.6** （可选）跑一次 `bun run src/feishu.ts download` 观察 priority 是否在含 `<cite>` 未命中的文档下载后 +1

## 7. 文档更新

- [x] **7.1** 更新 `docs/feishu/overview.md`
  - `nodes` 表新增 `priority` 列说明（默认 0，单调累加，下载阶段未就绪被引方 +1）
  - 模块结构表保持不变（无新增模块）
- [ ] **7.2** 更新 `docs/feishu/business.md`
  - "飞书文档下载" 章节补充 priority 副作用（callback 三分支、未命中 +1 语义、单调累加、`--force` 虚高说明）
  - 状态：延后 — 用户当前正在改 `docs/feishu/business.md`（git status 显示 modified），等用户合并后再补，避免编辑冲突
- [x] **7.3** 更新 `docs/feishu/flows.md`
  - download 流程图：callback 闭包内三分支
  - sync-updated-at 流程图：队列加 `ORDER BY priority DESC, node_token ASC`
  - "关键设计决策" 章节新增："按引用需求度排序下载队列"
- [x] **7.4** 更新 `README.md`（如有升级说明章节）：新增 priority 字段说明，存量默认 0，无需主动重算

## 任务依赖关系

- **执行顺序**：1（迁移）→ 2（DB 层）→ 3（download）→ 4（sync-updated-at）→ 5（测试）→ 6（验证与审查）→ 7（文档）
- **依赖关系**：
  - 2 依赖 1
  - 3 依赖 2
  - 4 依赖 2
  - 5 依赖 2、3、4（要等被测代码就位）
  - 6 依赖 5
  - 7 可与 5、6 并行（文档独立于代码细节，但建议在代码冻结后写）
- **可并行**：
  - 4 的 4.1 / 4.2 / 4.3 是 3 处独立 SQL，可由不同 Agent 改同一文件但需协调避免编辑冲突（建议顺序执行同一文件）
  - 7 的 7.1 / 7.2 / 7.3 / 7.4 是 4 份独立文档，可完全并行
- **必须串行**：
  - 1 → 2 → 3 → 4：迁移必须先于代码，否则 SQL 引用未存在的列会运行时报错
  - 2 → 5.2：被测函数 `getDownloadQueue` 改了 SQL 才能测
  - 3 → 5.1：被测函数 `incrementNodePriority` 改了 callback 调用才能（可选地）测 callback 路径
- **其他约束**：
  - `tests/feishu/utils.test.ts` 无需新增/修改——callback 签名不变，所有现有断言继续生效
  - 5.1 与 5.2 可并行（不同 describe 块）
  - 6.4 必须在 6.1/6.2/6.3 通过后再跑
