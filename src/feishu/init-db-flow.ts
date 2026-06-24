// 飞书数据库迁移执行器 (cmd.feishu init-db)
// 按序号读取并应用 SQL 迁移文件，通过 _migrations 表保证幂等执行

import { Database } from 'bun:sqlite';
import { readdirSync, readFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { C } from '../shared/colors';

interface Migration {
    filename: string;
    sql: string;
}

/**
 * 从 migrations/ 目录加载所有 .sql 文件，按文件名排序。
 * 使用 process.cwd() 解析目录路径，相对于命令运行时的当前目录。
 */
function loadMigrations(): Migration[] {
    const migrationsDir = join(process.cwd(), 'src/feishu/migrations');
    const files = readdirSync(migrationsDir)
        .filter((f) => f.endsWith('.sql'))
        .sort(); // 字母序 = 时间序

    return files.map((filename) => ({
        filename,
        sql: readFileSync(join(migrationsDir, filename), 'utf-8')
    }));
}

/**
 * 执行 init-db 迁移。
 *
 * @param outputDir 输出目录，feishu.db 位于 {outputDir}/data/feishu.db
 */
export function runInitDB(outputDir: string): void {
    const dbPath = join(outputDir, 'data', 'feishu.db');
    mkdirSync(dirname(dbPath), { recursive: true });

    const db = new Database(dbPath, { create: true });
    db.run('PRAGMA journal_mode=WAL');
    db.run('PRAGMA foreign_keys=ON');

    try {
    // 创建迁移跟踪表
        db.run(`
      CREATE TABLE IF NOT EXISTS _migrations (
        filename   TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL
      )
    `);

        // 加载迁移文件
        const migrations = loadMigrations();

        // 查询已应用的迁移
        const appliedRows = db.query('SELECT filename FROM _migrations').all() as { filename: string }[];
        const applied = new Set(appliedRows.map((r) => r.filename));

        const pending = migrations.filter((m) => !applied.has(m.filename));

        if (pending.length === 0) {
            console.log(`  ${C.green}✓${C.reset} 所有 ${migrations.length} 个迁移已应用，无需执行\n`);
            return;
        }

        console.log(`  ${C.bold}init-db${C.reset}: 待执行迁移 ${pending.length} 个 (总计 ${migrations.length} 个)\n`);

        let appliedCount = 0;
        let skippedCount = 0;

        for (const migration of pending) {
            // 006 特殊处理：检查 images 表是否已有复合主键
            if (migration.filename === '006_rebuild_images_pk.sql') {
                const tableExists = db
                    .query("SELECT name FROM sqlite_master WHERE type='table' AND name='images'")
                    .get() as { name: string } | null;
                if (tableExists) {
                    const cols = db.query('PRAGMA table_info(images)').all() as { name: string }[];
                    const hasNodeToken = cols.some((c) => c.name === 'node_token');
                    if (hasNodeToken) {
                        // 新 schema 已就绪，直接标记为已应用
                        db.run('INSERT INTO _migrations (filename, applied_at) VALUES (?, ?)', [
                            migration.filename,
                            new Date().toISOString()
                        ]);
                        console.log(`  ${C.dim}○${C.reset} ${migration.filename} — 已跳过（复合主键已存在）`);
                        skippedCount++;
                        continue;
                    }
                }
            }

            // 007 特殊处理：检查 nodes 表是否已移除 obj_edit_time 列
            if (migration.filename === '007_drop_obj_edit_time.sql') {
                const tableExists = db
                    .query("SELECT name FROM sqlite_master WHERE type='table' AND name='nodes'")
                    .get() as { name: string } | null;
                if (tableExists) {
                    const cols = db.query('PRAGMA table_info(nodes)').all() as { name: string }[];
                    const hasObjEditTime = cols.some((c) => c.name === 'obj_edit_time');
                    if (!hasObjEditTime) {
                        db.run('INSERT INTO _migrations (filename, applied_at) VALUES (?, ?)', [
                            migration.filename,
                            new Date().toISOString()
                        ]);
                        console.log(`  ${C.dim}○${C.reset} ${migration.filename} — 已跳过（列已不存在）`);
                        skippedCount++;
                        continue;
                    }
                }
            }

            // 012 特殊处理：检查 nodes 表是否已移除 image_uploaded 列
            if (migration.filename === '012_drop_image_uploaded.sql') {
                const tableExists = db
                    .query("SELECT name FROM sqlite_master WHERE type='table' AND name='nodes'")
                    .get() as { name: string } | null;
                if (tableExists) {
                    const cols = db.query('PRAGMA table_info(nodes)').all() as { name: string }[];
                    const hasImageUploaded = cols.some((c) => c.name === 'image_uploaded');
                    if (!hasImageUploaded) {
                        db.run('INSERT INTO _migrations (filename, applied_at) VALUES (?, ?)', [
                            migration.filename,
                            new Date().toISOString()
                        ]);
                        console.log(`  ${C.dim}○${C.reset} ${migration.filename} — 已跳过（列已不存在）`);
                        skippedCount++;
                        continue;
                    }
                }
            }

            // 014 特殊处理：检查 nodes 表是否已移除 downloaded 列
            if (migration.filename === '014_drop_downloaded.sql') {
                const tableExists = db
                    .query("SELECT name FROM sqlite_master WHERE type='table' AND name='nodes'")
                    .get() as { name: string } | null;
                if (tableExists) {
                    const cols = db.query('PRAGMA table_info(nodes)').all() as { name: string }[];
                    const hasDownloaded = cols.some((c) => c.name === 'downloaded');
                    if (!hasDownloaded) {
                        db.run('INSERT INTO _migrations (filename, applied_at) VALUES (?, ?)', [
                            migration.filename,
                            new Date().toISOString()
                        ]);
                        console.log(`  ${C.dim}○${C.reset} ${migration.filename} — 已跳过（列已不存在）`);
                        skippedCount++;
                        continue;
                    }
                }
            }

            // 010 特殊处理：检查 image_vs_node 表是否已存在
            if (migration.filename === '010_split_images.sql') {
                const tableExists = db
                    .query("SELECT name FROM sqlite_master WHERE type='table' AND name='image_vs_node'")
                    .get() as { name: string } | null;
                if (tableExists) {
                    db.run('INSERT INTO _migrations (filename, applied_at) VALUES (?, ?)', [
                        migration.filename,
                        new Date().toISOString()
                    ]);
                    console.log(`  ${C.dim}○${C.reset} ${migration.filename} — 已跳过（image_vs_node 已存在）`);
                    skippedCount++;
                    continue;
                }
            }

            try {
                db.transaction(() => {
                    // 按分号拆分多条语句分别执行（SQLite 一次只能执行一条语句）
                    const statements = splitSQLStatements(migration.sql);
                    for (const stmt of statements) {
                        db.run(stmt);
                    }
                    db.run('INSERT INTO _migrations (filename, applied_at) VALUES (?, ?)', [
                        migration.filename,
                        new Date().toISOString()
                    ]);
                })();
                console.log(`  ${C.green}✓${C.reset} ${migration.filename}`);
                appliedCount++;
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                // ALTER TABLE 重复添加列时视为幂等成功
                if (msg.includes('duplicate column name')) {
                    db.transaction(() => {
                        db.run('INSERT INTO _migrations (filename, applied_at) VALUES (?, ?)', [
                            migration.filename,
                            new Date().toISOString()
                        ]);
                    })();
                    console.log(`  ${C.dim}○${C.reset} ${migration.filename} — 已跳过（列已存在）`);
                    skippedCount++;
                } else {
                    console.error(`  ${C.red}✗${C.reset} ${migration.filename} 执行失败: ${msg}\n`);
                    throw err;
                }
            }
        }

        console.log(`\n  ${C.green}✓${C.reset} 迁移完成: ${appliedCount} 已应用, ${skippedCount} 已跳过\n`);
    } finally {
        db.close();
    }
}

/**
 * 拆分多条 SQL 语句。
 * 按分号分割，跳过空语句和纯注释行块。
 */
function splitSQLStatements(sql: string): string[] {
    const statements: string[] = [];
    // 按分号分割，保留有实际内容的语句
    const parts = sql.split(';');
    for (const part of parts) {
        const trimmed = part.trim();
        if (!trimmed) continue;
        // 跳过纯注释块
        const nonCommentLines = trimmed
            .split('\n')
            .filter((line) => !line.trim().startsWith('--'));
        if (nonCommentLines.length === 0) continue;
        statements.push(trimmed);
    }
    return statements;
}
