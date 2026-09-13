/**
 * HTTP 边界回归测试 —— 盯住两个曾经真实存在的缺陷：
 *
 * 1. 静态资源落在 token 鉴权之后。浏览器打开 http://127.0.0.1:<port>/ 时
 *    无法为页面/脚本请求附加自定义头，必然 401，生产模式前端永远打不开。
 * 2. webDir 只在 daemon 启动时解析一次。`apps/web/dist` 通常在 daemon 之后
 *    才 build 出来，于是 build 完也不生效，必须重启。
 *
 * 顺带守住免鉴权后的目录穿越面。
 *
 * 依赖 @car/* 的源码入口（package main 指向 src/index.ts），因此必须用 tsx 跑：
 *   node node_modules/tsx/dist/cli.mjs --test apps/daemon/test/http-static.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { request as httpRequest } from "node:http";
import { SqliteRepository } from "@car/persistence";
import { startHttpApi, resolveStaticPath, type HttpApiDeps } from "../src/http-api.js";

interface Resp {
  status: number;
  body: string;
  contentType: string | null;
}

/** 用原始 http.request 发请求，避免 fetch 把 `..` 规范化掉，才好测目录穿越。 */
function rawGet(port: number, path: string, headers: Record<string, string> = {}): Promise<Resp> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path, method: "GET", headers }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (body += c));
      res.on("end", () =>
        resolve({ status: res.statusCode ?? 0, body, contentType: (res.headers["content-type"] as string) ?? null }),
      );
    });
    req.on("error", reject);
    req.end();
  });
}

function makeWebDir(marker: string): string {
  const dir = mkdtempSync(join(tmpdir(), "car-web-"));
  mkdirSync(join(dir, "assets"), { recursive: true });
  writeFileSync(join(dir, "index.html"), `<html><body>${marker}</body></html>`);
  writeFileSync(join(dir, "assets", "app.js"), `console.log("${marker}");`);
  return dir;
}

async function boot(overrides: Partial<HttpApiDeps> = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "car-api-"));
  const repo = new SqliteRepository(":memory:");
  repo.migrate();
  const noop = () => {};
  const deps: HttpApiDeps = {
    repo,
    client: {} as HttpApiDeps["client"],
    dataDir,
    logger: { info: noop, warn: noop, error: noop, debug: noop } as unknown as HttpApiDeps["logger"],
    getQuotaSnapshot: () => null,
    getAutoRun: () => false,
    setAutoRun: noop,
    ...overrides,
  };
  const http = await startHttpApi(deps, 0);
  return { http, repo, dataDir };
}

function cleanup(dirs: string[]): void {
  for (const d of dirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* 临时目录，忽略 */
    }
  }
}

test("static assets are served without a token (browser cannot send one)", async () => {
  const web = makeWebDir("STATIC-OK");
  const { http, repo, dataDir } = await boot({ getWebDir: () => web });
  try {
    const root = await rawGet(http.port, "/");
    assert.equal(root.status, 200, "GET / 必须免鉴权返回 200（此前为 401）");
    assert.match(root.body, /STATIC-OK/);
    assert.match(root.contentType ?? "", /text\/html/);

    const asset = await rawGet(http.port, "/assets/app.js");
    assert.equal(asset.status, 200);
    assert.match(asset.contentType ?? "", /javascript/);

    // SPA 深链回退到 index.html
    const deep = await rawGet(http.port, "/tasks/123");
    assert.equal(deep.status, 200);
    assert.match(deep.body, /STATIC-OK/);
  } finally {
    http.close();
    repo.close();
    cleanup([web, dataDir]);
  }
});

test("api routes still require the token", async () => {
  const { http, repo, dataDir } = await boot();
  try {
    const anon = await rawGet(http.port, "/api/status");
    assert.equal(anon.status, 401, "/api/* 无 token 必须 401");

    const authorized = await rawGet(http.port, "/api/status", { "X-Car-Token": http.token });
    assert.equal(authorized.status, 200);
    const payload = JSON.parse(authorized.body) as { autoRun: boolean; tasks: unknown[] };
    assert.equal(payload.autoRun, false);
    assert.ok(Array.isArray(payload.tasks));

    // 健康检查保持开放
    const health = await rawGet(http.port, "/healthz");
    assert.equal(health.status, 200);
  } finally {
    http.close();
    repo.close();
    cleanup([dataDir]);
  }
});

test("webDir is resolved lazily, so a dist built after startup is picked up without restart", async () => {
  let webDir: string | undefined; // 模拟「启动时 dist 还不存在」
  const { http, repo, dataDir } = await boot({ getWebDir: () => webDir });
  try {
    const before = await rawGet(http.port, "/");
    assert.equal(before.status, 404, "dist 尚未 build 时应 404");

    webDir = makeWebDir("BUILT-LATER"); // dist 现在才出现
    const after = await rawGet(http.port, "/");
    assert.equal(after.status, 200, "build 之后无需重启 daemon 就应能访问");
    assert.match(after.body, /BUILT-LATER/);

    cleanup([webDir]);
  } finally {
    http.close();
    repo.close();
    cleanup([dataDir]);
  }
});

test("a traversal attempt cannot read files outside webDir", async () => {
  const web = makeWebDir("SAFE");
  const { http, repo, dataDir } = await boot({ getWebDir: () => web });
  try {
    // 安全属性：仓库文件内容一律不得外泄。
    // 常规 `..` / `%2e%2e` 会被 WHATWG URL 解析提前折叠（下面直接验证），
    // resolveStaticPath 的前缀校验再兜一层。
    for (const p of ["/../../package.json", "/%2e%2e/%2e%2e/package.json", "/assets/../../package.json"]) {
      const r = await rawGet(http.port, p);
      assert.ok(r.status === 200 || r.status === 403, `路径 ${p} 返回了意外状态 ${r.status}`);
      assert.doesNotMatch(r.body, /"name"\s*:\s*"codex-auto-runner"/, `路径 ${p} 泄露了仓库文件`);
    }

    // 正常路径不受影响
    const ok = await rawGet(http.port, "/index.html");
    assert.equal(ok.status, 200);
    assert.match(ok.body, /SAFE/);
  } finally {
    http.close();
    repo.close();
    cleanup([web, dataDir]);
  }
});

test("resolveStaticPath keeps every mapping inside webDir", () => {
  const web = makeWebDir("SAFE");
  try {
    // 越界一律 null
    assert.equal(resolveStaticPath(web, "/../../package.json"), null);
    assert.equal(resolveStaticPath(web, "/./../../secrets.txt"), null);
    assert.equal(resolveStaticPath(web, "/a/../../outside.txt"), null);

    // 根路径映射到 index.html，正常资源映射到自身
    assert.equal(resolveStaticPath(web, "/"), resolve(join(web, "index.html")));
    assert.equal(resolveStaticPath(web, "/assets/app.js"), resolve(join(web, "assets", "app.js")));

    // 编码的斜杠不是路径分隔符，只会落成 webDir 内的字面文件名
    const weird = resolveStaticPath(web, "/..%2fpackage.json");
    assert.ok(weird === null || weird.startsWith(resolve(web)), "编码路径不得越界");
  } finally {
    cleanup([web]);
  }
});
