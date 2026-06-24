// CLI 帮助文本：从 registry 动态拼装
// 顶层 help 列出所有命令的 summary；单命令 help 由 spec.help 提供。

import { C } from '../../shared/colors';
import { commandSpecs } from './registry';

export function printHelp() {
    const cmds = Object.values(commandSpecs)
        .filter((s) => s.name !== 'help')
        .map((s) => `  ${s.name.padEnd(15)} ${s.summary}`)
        .join('\n');

    console.log(`
${C.bold}飞书知识库工具${C.reset}

${C.dim}Usage:${C.reset}
  bun run src/feishu.ts <command> [options]

${C.dim}Commands:${C.reset}
${cmds}

${C.dim}通用选项:${C.reset}
  --output, -o <dir>   输出目录 (默认: ./docs/feishu)
  --help, -h           显示帮助

${C.dim}示例:${C.reset}
  bun run src/feishu.ts sync
  bun run src/feishu.ts download
`);
}
