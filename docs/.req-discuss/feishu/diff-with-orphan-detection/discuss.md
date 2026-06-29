# copydocs 目标目录孤儿副本检测 (v2 推翻) 需求变更讨论

> ⚠️ **本文档为 v2 版本**,推翻同目录下原 v1 讨论中确立的"按 human_path 反查 + case 1 / case 2 candidate 启发式"方案。
> **推翻原因**:v1 在真实数据上实测,基于 human_path 反查会因作者改动 `slug:` 而**大量误报**(典型 aimDirectory 中报出几十个孤儿,但其中大部分只是 slug 改名)。新方案用"title 全库匹配"作为兜底,直接给出飞书 URL 让用户跳回核对,误报大幅减少。
> **实施状态**:v1 代码与测试已落地但未发布,本次 v2 直接覆盖。
> **CLI 行为变更**:`--group` flag → 必填位置参数 `<group>`(破坏性变更,因 v1 未发布,无用户影响)。

## 需求背景

`cmd.feishu copy-docs` 把 `{outputDir}/{file_path}` 复制到 `{aimDirectory}/{human_path}.md`,单向写入,不会反向清理孤儿副本。

v1 方案按 `human_path` 反查,但 human_path 跟随 frontmatter `slug:` 漂移——作者改一次 slug,旧 aimDirectory 副本就被错报为孤儿(实际上 DB 里有对应节点,只是 human_path 改成了新值)。

v2 改为"三级判定":
- **L1 路径+group 匹配** → 静默(确定有效)
- **L2 标题全库匹配** → 列出 + 飞书 URL(很可能是"slug 改名后的旧副本",给出 URL 让用户跳转核对)
- **L3 无匹配** → 警告(真正需要清理的孤儿)

需求:重写 `cmd.feishu diff-with`,把 `--group` 改为必填位置参数,实现上述三级判定,输出纯文本清单。

## 讨论后的关键结论

- **位置参数 group,必填,不传报错退出**(与 copy-docs --group 严格模式语义一致)
- **三级判定**:
  - L1:DB 中 `human_path = ? AND "group" = ?` 命中 → 静默
  - L2:L1 未命中,读文件 frontmatter `title` 字段,DB 中 `title = ?` 全库匹配 → 列出 + 每个匹配节点打印一行 `https://feishu.cn/wiki/<node_token>`
  - L3:L1 + L2 都未命中 → 警告
- **飞书 URL 硬编码** `https://feishu.cn/wiki/<node_token>`(Feishu 跨租户跳转机制保证可用,零配置)
- **title 全库匹配**:同标题跨 group 匹配都列出(不按 group 过滤),允许一份历史 slug 漂移文档定位到原 group 之外的同名节点
- **frontmatter 缺失或 title 为空** → 警告(标为无法按标题反查)
- **URL 输出格式**:主清单行 `[<group>] <human_path>.md — 标题匹配 N 个:`,子行每个 URL 独立一行
- **不再 fan-out**:group 必填,固定单 group
- **CLI 扩展**:parse-args.ts 新增通用位置参数能力(`positional: { name, required }` 配置),其他子命令未来可用
- **共享 helper**:`resolveAimDirectory`、`findMdFiles`、`parseFrontmatterMeta` 全部复用现有
- **v1 抛弃的概念**:`case 1 / case 2 candidate` 启发式;`group` 缺 fallback 到 default 后跳过(fan-out 模式);`--group` flag

## 需求目标

重写 `cmd.feishu diff-with`,把"按 human_path 反查"改为"按 human_path+group 严格匹配、再按 title 全库兜底"的三级判定;CLI 把 `--group` 改为必填位置参数 `<group>`。只读输出,只列不删。

**边界**:
- 不修改 `copy-docs` / `download` / `sync` 任何已有逻辑
- 不写 DB、不删文件、不调外部 API
- 不支持 fan-out(group 必填,固定单 group)
- 不修改 DB schema
- 不引入 `--group` 兼容(因 v1 未发布,直接换语法)
- aimDirectory 解析沿用 `src/feishu/aim-dir.ts:resolveAimDirectory`

## 当前流程(v2)

```
runDiffWith(args):
  1. DB 存在检查:不存在 → throw("请先运行 sync")
  2. GROUP_VALID_RE 校验 args.group
  3. resolveAimDirectory → 缺则 throw
  4. findMdFiles(aimDirectory)  → 全量 .md 列表
  5. for each .md:
       slug = relative(aimDir, abs) → 去 .md → / 标准化
       // L1: 路径 + group 匹配 → 静默
       row = SELECT * FROM nodes WHERE human_path = ? AND "group" = ?
       if row: continue
       // L2: 标题全库匹配 → 列出 + URL
       title = readTitleFromFrontmatter(abs)  // Bun.file + parseFrontmatterMeta
       if title 缺失或空字符串:
         warn "[<group>] <slug>.md — frontmatter 缺失,无法按标题反查"
         continue
       rows = SELECT node_token, title FROM nodes WHERE title = ?
       if rows.length > 0:
         print "[<group>] <slug>.md — 标题匹配 N 个:"
         for each row: print "  https://feishu.cn/wiki/<node_token>"
       else:
         warn "[<group>] <slug>.md — 无任何匹配"
  6. 末尾打印:✓ 扫描 N 个文件, 列出 X 个标题匹配, 警告 Y 个
```

## 影响分析

### 1. `src/feishu/diff-with-flow.ts`(**重写**)

需要重写:
- `runDiffWith` 主函数:去掉 fan-out、`--group` flag 处理、case 1/case 2 启发式、空 human_path 预查询
- 新增 `readTitleFromFrontmatter(absPath): string | null`:用 `Bun.file(absPath).text()` + `parseFrontmatterMeta(content).title` 读 title;title 缺失或空字符串返回 null
- 新增 `buildFeishuUrl(nodeToken: string): string`:返回 `https://feishu.cn/wiki/${nodeToken}`(直接模板拼接)
- 保留:`absPathToHumanPath`(供 slug 计算)与 `runDiffWith` 函数签名(对外暴露同名)

可保留:
- DB 存在检查
- GROUP_VALID_RE 校验
- `findMdFiles` 调用
- `resolveAimDirectory` 调用

### 2. `src/feishu/cli/{types,registry,parse-args,main}.ts`(**4 处微改**)

**types.ts**:
- `DiffWithArgs` 字段不变(仍是 `{ output, group: string }`),但 `group` 从"可选"语义变"必填"
- 在 `DiffWithArgs` 注释里说明 group 必填

**registry.ts**:
- `commandSpecs['diff-with']`:
  - 删除 `flags: [{ names: ['--group', '-g'], ... }]`
  - 新增 `positional: { name: 'group', required: true, description: '...' }`
  - `buildArgs` 改为 `(common) => ({ ...common })`(不预填 group)
  - `help` 文本:删除 `--group, -g` 行,改为 `<group>` 位置参数说明(在 `Usage:` 段)
- 同步更新 `ArgsByCommand` 联合(如需)

**parse-args.ts**:
- 新增位置参数解析能力:
  - `CommandSpec` 接口增加 `positional?: { name: string; required: boolean; description?: string }`
  - 在 `for` 循环里,如果当前 arg 不以 `-` 开头且不是已识别的 command,视为位置参数
  - 对当前 command 的 `positional.required = true` 时,缺失则 throw("未传入 <positional.name> 参数\n  提示: cmd.feishu <command> <positional.name>")
  - 对当前 command 的 `positional` 进行赋值
- `AnyArgs` 联合不变(DiffWithArgs 字段不变)

**main.ts**:
- 不变(dispatch 仍是 `case 'diff-with'` 调 `commandSpecs['diff-with'].run(args)`)

### 3. `src/feishu/utils/markdown.ts`(**无改动**)

`parseFrontmatterMeta` 已导出,直接 `import { parseFrontmatterMeta } from './utils'` 即可。

### 4. `src/feishu/aim-dir.ts`(**无改动**)

helper 仍被 `copy-docs` 与 `diff-with` 共用,签名兼容。

### 5. 测试(**重写 + 保留**)

- `tests/feishu/aim-dir.test.ts`:**全部保留**(helper 行为不变,7 个测试已绿)
- `tests/feishu/diff-with.test.ts`:**重写**
  - 删除 v1 的 18 个旧测试
  - 新增覆盖矩阵:
    | # | 场景 | 期望 |
    |---|------|------|
    | 1 | DB 不存在 | throw 提示先跑 sync |
    | 2 | 位置参数 group 缺失 | throw "未传入 group 参数" + 提示 |
    | 3 | 位置参数 group 非法(大写) | throw 提示命名规则 |
    | 4 | 位置参数 group 未配置 aimDirectory | throw 提示配置哪一组 |
    | 5 | aimDirectory 目录不存在 | 跳过(group)/0 输出 |
    | 6 | aimDirectory 为空 | 0 输出 |
    | 7 | L1 命中:DB 中有 human_path+group 匹配 | 静默,不出现在清单 |
    | 8 | L2 命中:DB 中无 human_path 匹配,但 title 匹配 1 个 | 清单列出 + 1 行 URL |
    | 9 | L2 多匹配:title 匹配 3 个 | 清单列出 + 3 行 URL |
    | 10 | L2 跨 group 匹配:title 命中其他 group 的节点 | 仍然列出(全库匹配) |
    | 11 | L3 无匹配:路径 + 标题都无 | 警告 |
    | 12 | frontmatter 缺失 | 警告 "无法按标题反查" |
    | 13 | frontmatter 存在但 title 为空字符串 | 警告(同 #12) |
    | 14 | aimDirectory 排除 images/ 与 data/ 子目录 | 行为同 v1(沿用 findMdFiles) |
    | 15 | 多级子目录路径(如 `guide/install.md`) | slug 正确解析为 `guide/install` |

### 6. 文档(**同步**)

- `docs/feishu/overview.md`:
  - 功能入口行:删除 `--group, -g <name>` 描述
  - 构建后的命令:删除 `cmd.feishu diff-with --group <group_name>`,加 `cmd.feishu diff-with <group>`
- `docs/feishu/business.md`:
  - §"反查与孤儿副本检测" 整段重写:从"两类 orphan 判定"改为"三级判定"
- `docs/feishu/flows.md`:
  - §"目标目录孤儿副本检测流程" 流程图整段重写

### 7. 级联副作用

- **零**对其他子命令(copy-docs / download / sync 行为完全不变)
- `parse-args.ts` 新增的位置参数能力是**通用增强**,未来其他子命令也可声明 positional
- aim-dir.ts 不动

### 8. 数据一致性与过渡

- **CLI 破坏性变更**:`--group` flag 删除 → 位置参数 `<group>`(v1 未发布,无用户影响)
- 旧 DB 无需迁移(v1 也没改 schema)
- aimDirectory 内容不动(v1 也不动)

### 9. 性能风险

- 每文件**额外一次** frontmatter 读取:`Bun.file(absPath).text()`(几 KB 文件 < 1ms)
- 每文件**额外一次** title 全库查询:`SELECT ... WHERE title = ?`(无 group 过滤,无索引,小表扫描 < 1ms)
- 1k 文件量级 ~1~2s
- 暂不加 `nodes.title` 索引(后续按需评估)

## 方案对比

### 方案 A:位置参数 group + 三级判定(**推荐**)

**核心思路**:完全按 v2 设计,CLI `diff-with <group>` 位置必填,主流程三级判定。

**优点**:
- 消除 v1 "case 2 candidate 启发式无法 1:1 关联"问题
- title 匹配直接给出飞书 URL,用户能直接跳转核对
- 误报大幅减少(title 改的概率远小于 slug)
- CLI 位置参数符合 Unix 风格(与 `git diff <commit>` 等一致)
- parse-args.ts 新增的位置参数能力是顺带增强,后续其他子命令可用

**缺点**:
- 破坏性 CLI 变更(v1 未发布,无用户影响)
- 需新增位置参数解析(parse-args.ts 小扩展)
- 每文件多一次文件 I/O(title 读取)

**实施复杂度**:中(重写 diff-with-flow + 重写测试 + CLI 小扩展 + 文档更新)

### 方案 B:保留 `--group` 但加 title 兜底(不推荐)

**核心思路**:v1 CLI 不变,新增 title 全库匹配逻辑。

**优点**:
- CLI 不破坏

**缺点**:
- 不符合用户新要求("必须指定 group, group 作为参数")
- 没有解决 fan-out 模式与"必须 group"的冲突
- 与用户明确表达的设计意图相悖

**实施复杂度**:低

### 方案 C:把 diff-with 拆为两个子命令(不推荐)

**核心思路**:`diff-with <group>` 走新逻辑;保留 `diff-with --all` 走 v1 fan-out。

**缺点**:
- 过度设计,v1 还没用户
- 增加 CLI 表面

**实施复杂度**:中

## 推荐方案

**方案 A**。理由:与用户明确表达的设计意图一致;消除 v1 误报;与 Unix CLI 风格对齐;CLI 位置参数的小扩展对 parse-args.ts 来说是顺带增强。

## 待确认事项

| # | 项 | 默认假设 |
|---|----|---------|
| 1 | `--group` 是否完全移除(不留兼容) | 完全移除(v1 未发布) |
| 2 | parse-args.ts 新增 `positional` 能力是否需要通用化 | 通用化(`CommandSpec.positional?: { name, required, description? }`),为未来其他子命令铺路 |
| 3 | URL 域名 `feishu.cn` 是否会随企业租户变化 | 硬编码 `feishu.cn`(Feishu 跨租户跳转机制保证可用) |
| 4 | 退出码:0 orphan / 0 文件 / DB 不存在 / 参数错 | 0 / 0 / 1 / 1(预检查失败 throw 非 0) |
| 5 | 是否加 `nodes.title` 索引 | 本期不加,1k~10k 文件量级可接受 |

## 实施建议

按层自底向上:

1. **CLI 位置参数能力**(`src/feishu/cli/parse-args.ts` + `registry.ts` + `types.ts`)
   - `CommandSpec` 增加 `positional?` 字段
   - parse-args 循环支持位置参数 + 必填校验
   - `commandSpecs['diff-with']` 移除 `--group` flag,新增 `positional`
2. **重写 diff-with-flow.ts**:`runDiffWith` + `readTitleFromFrontmatter` + `buildFeishuUrl`
3. **重写 diff-with.test.ts**:15 个新场景
4. **aim-dir.test.ts**:7 个旧测试全保留,确认不需改
5. **文档同步**:`docs/feishu/{overview,business,flows}.md` 三处
6. **完整测试**:`bun test` + `bun run lint` + 手动 `cmd.feishu diff-with <group>`

## 结论

本次变更是对 v1 "按 human_path 反查"方案的**设计推翻**。v1 误报率高(实测中真实数据触发大量 slug 改名导致的误报),v2 改为"路径+group 严格匹配 → 标题全库兜底"的三级判定,把误报与真正的孤儿分离,并通过飞书 URL 让用户能直接跳回核对。CLI 把 `--group` 改为位置必填参数,符合 Unix 风格,并为 parse-args.ts 带来顺带的"位置参数通用解析"能力扩展。
