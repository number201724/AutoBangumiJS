/**
 * Post-build assembler: collects everything needed to run production into
 * <repo>/dist so that `node dist/main.js` works from the repo root.
 *
 *   dist/
 *   ├── main.js + 后端全部编译产物（来自 apps/backend/dist）
 *   ├── webui/         前端构建产物（来自 apps/webui/dist）
 *   └── node_modules   符号链接 → apps/backend/node_modules（后端运行时依赖）
 *
 * 产物里的 version.js 被打成 'local'（启用生产模式：config.json + 静态托管），
 * 开发源码 src/version.ts 保持 DEV_VERSION 不变。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'dist');
const backendDist = path.join(root, 'apps/backend/dist');
const webuiDist = path.join(root, 'apps/webui/dist');

function copyDir(src, dest) {
  fs.cpSync(src, dest, { recursive: true });
}

for (const dir of [backendDist, webuiDist]) {
  if (!fs.existsSync(dir)) {
    console.error(`error: ${dir} 不存在，请先运行 pnpm -r build`);
    process.exit(1);
  }
}

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

// 1. 后端产物
copyDir(backendDist, outDir);

// 2. 前端产物 -> dist/webui
copyDir(webuiDist, path.join(outDir, 'webui'));

// 3. 产物版本号 -> 'local'（生产模式）。tsc 输出为 CJS：exports.VERSION = '...'
const versionFile = path.join(outDir, 'version.js');
const versionSrc = fs.readFileSync(versionFile, 'utf-8');
const patched = versionSrc.replace(/exports\.VERSION = '.*';/, "exports.VERSION = 'local';");
if (patched === versionSrc) {
  console.error('error: 无法在 dist/version.js 中定位 VERSION 赋值');
  console.error('version.js 内容:\n' + versionSrc);
  process.exit(1);
}
fs.writeFileSync(versionFile, patched);

// 4. node_modules 链接（pnpm 单仓后端依赖在 apps/backend/node_modules）
const nmLink = path.join(outDir, 'node_modules');
fs.rmSync(nmLink, { recursive: true, force: true });
try {
  fs.symlinkSync(path.join('..', 'apps', 'backend', 'node_modules'), nmLink, 'junction');
} catch (e) {
  console.warn(`warn: 无法创建 node_modules 链接（${e.message}），改为复制（较慢）`);
  copyDir(path.join(root, 'apps/backend/node_modules'), nmLink);
}

console.log(`dist 组装完成 -> ${outDir}`);
console.log('启动: node dist/main.js   （从仓库根目录运行）');
