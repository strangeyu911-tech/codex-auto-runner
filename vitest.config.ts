import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: [
      "packages/quota-engine/test/**/*.test.ts",
      "packages/task-engine/test/**/*.test.ts",
      "test/**/*.test.ts",
    ],
    // 根 test/ 下的端到端用例依赖 node:sqlite 内置模块，vitest 的解析器处理不了，
    // 由 `node --test test/quota-resume-e2e.test.ts`（见 package.json 的 test 脚本）单独跑。
    exclude: ["test/quota-resume-e2e.test.ts", "**/node_modules/**"],
    pool: "forks",
  },
});
