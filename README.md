# 同步 / 提交

## 下载

```bash
# 环境前置检查（可选）
bun run ./src/feishu.ts check

# All
bun run ./src/feishu.ts sync && \
bun run ./src/feishu.ts sync-updated-at && \
bun run ./src/feishu.ts download && \
bun run ./src/feishu.ts copy-docs

# 同步 & 下载 & 复制 : default
bun run ./src/feishu.ts sync --space 7562969962420109313 && \
bun run ./src/feishu.ts sync-updated-at --space 7562969962420109313 && \
bun run ./src/feishu.ts download --space 7562969962420109313 && \
bun run ./src/feishu.ts copy-docs --group default

# 同步 & 下载 & 复制 : weiran
bun run ./src/feishu.ts sync --space 7653435995085343712 && \
bun run ./src/feishu.ts sync-updated-at --space 7653435995085343712 && \
bun run ./src/feishu.ts download --space 7653435995085343712 && \
bun run ./src/feishu.ts copy-docs --group weiran


# 强制下载
bun run ./src/feishu.ts download --space 7562969962420109313 --force

# 强制下载单个
bun run ./src/feishu.ts download --node-token HXSRwur4PiWBAbkbtFrcF55UnMg --force && \
bun run ./src/feishu.ts copy-docs --group default

# 下载和复制
bun run ./src/feishu.ts download --force --node-token CE5tw2imeiUHlpk0B3HcNS9Vn5b && 
bun run ./src/feishu.ts download --force --node-token XAIXwxmkMi4dy5kh7cKc9i24nub && 
bun run ./src/feishu.ts download --force --node-token A3ACwQNfTin6Rrk1t6LcWyYgnLe && 
bun run ./src/feishu.ts download --force --node-token YRhhwmtQTi6YWlkcfgdcaxzSnTf && 
bun run ./src/feishu.ts download --force --node-token BrASwHaU2iYGnkkQoy4ckQWqnpg && 
bun run ./src/feishu.ts copy-docs --group default
```

## Sync Bash

```bash
#!/bin/bash

BIN_FEISHU=/webdata/feishu/bin/cmd.feishu
BIN_COMMIT=/webdata/feishu/bin/cmd.commit
DIR_WULICODE=/webdata/feishu/wulicode
DIR_WEIRAN=/webdata/feishu/weiran
DIR_FEISHU=/webdata/feishu/sync-feishu

$BIN_FEISHU sync && \
$BIN_FEISHU sync-updated-at && \
$BIN_FEISHU download && \
$BIN_FEISHU copy-docs && \
$BIN_COMMIT commit

cd $DIR_WEIRAN && $BIN_COMMIT --auto
cd $DIR_WULICODE && $BIN_COMMIT --auto
```