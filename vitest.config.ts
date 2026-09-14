import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { defineConfig, type Plugin } from "vitest/config";

/**
 * src/ 下残留着被 gitignore 的编译产物（index.js / repository.js …），而 Vite 的解析器
 * **优先命中真实存在的文件** —— 于是测试里的 `../src/index.js` 会静默加载过期副本，
 * 跑的就不是当前源码。
 *
 * tsx 的解析器本来就优先 .ts，所以 `tsx --test` 跑的测试没这个问题；这个插件把同样的
 * 行为补进 vitest：相对路径的 `.js` 若存在同名 `.ts`，一律解析到 `.ts`。
 * 测试文件因此可以继续按 NodeNext 惯例写 ".js"（tsc 也认），实际测的是源码。
 */
function preferTsOverStaleJs(): Plugin {
  return {
    name: "car:prefer-ts-over-stale-js",
    enforce: "pre",
    resolveId(source, importer) {
      if (!importer || !source.startsWith(".") || !source.endsWith(".js")) return null;
      const candidate = resolve(dirname(importer), source.replace(/\.js$/, ".ts"));
      return existsSync(candidate) ? candidate : null;
    },
  };
}

export default defineConfig({
  plugins: [preferTsOverStaleJs()],
  test: {
    environment: "node",
    include: [
      "packages/quota-engine/test/**/*.test.ts",
      "packages/task-engine/test/**/*.test.ts",
      "packages/git-guard/test/**/*.test.ts",
      "test/**/*.test.ts",
    ],
    // 根 test/ 下的端到端用例依赖 node:sqlite 内置模块，vitest 的解析器处理不了，
    // 由 `node --test test/quota-resume-e2e.test.ts`（见 package.json 的 test 脚本）单独跑。
    exclude: ["test/quota-resume-e2e.test.ts", "**/node_modules/**"],
    pool: "forks",
  },
});
