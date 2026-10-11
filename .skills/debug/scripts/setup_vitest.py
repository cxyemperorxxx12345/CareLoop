#!/usr/bin/env python3
"""setup_vitest.py — check test deps and scaffold vitest config files.

Usage:
    python3 scripts/setup_vitest.py --check   # check deps are resolvable (read-only)
    python3 scripts/setup_vitest.py           # write missing config files (existing ones are skipped)
    python3 scripts/setup_vitest.py --dir ./app

Writes vitest.config.ts / vitest.browser.config.ts / src/__tests__/setup.ts when absent.
Exit: 0 ok; 1 when --check finds missing deps.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

VITEST_CONFIG = '''import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);

const reactDir = path.dirname(
  require.resolve("react/package.json", { paths: [require.resolve("@testing-library/react")] })
);
const reactDomDir = path.dirname(
  require.resolve("react-dom/package.json", { paths: [require.resolve("@testing-library/react")] })
);

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/__tests__/setup.ts"],
    env: { NODE_ENV: "test" },
    exclude: ["**/node_modules/**", "**/*.browser.test.*"],
  },
  resolve: {
    dedupe: ["react", "react-dom"],
    alias: [
      { find: /^react$/, replacement: path.join(reactDir, "index.js") },
      { find: /^react\\/(.*)$/, replacement: path.join(reactDir, "$1") },
      { find: /^react-dom$/, replacement: path.join(reactDomDir, "index.js") },
      { find: /^react-dom\\/(.*)$/, replacement: path.join(reactDomDir, "$1") },
      { find: "@", replacement: path.resolve(import.meta.dirname, "./src") },
    ],
  },
});
'''

BROWSER_CONFIG = '''import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { playwright } from "@vitest/browser-playwright";
import { createRequire } from "node:module";
import path from "node:path";

if (process.env.NODE_ENV === "production" || !process.env.NODE_ENV) {
  process.env.NODE_ENV = "test";
}

const require = createRequire(import.meta.url);

const reactDir = path.dirname(
  require.resolve("react/package.json", { paths: [require.resolve("@testing-library/react")] })
);
const reactDomDir = path.dirname(
  require.resolve("react-dom/package.json", { paths: [require.resolve("@testing-library/react")] })
);

export default defineConfig({
  plugins: [react()],
  test: {
    env: { NODE_ENV: "test" },
    include: ["**/*.browser.test.*"],
    setupFiles: ["./src/__tests__/setup.browser.ts"],
    browser: {
      enabled: true,
      screenshotFailures: false,
      provider: playwright({
        launchOptions: {
          executablePath: "/usr/bin/chromium",
          args: ["--no-sandbox", "--disable-dev-shm-usage"],
        },
      }),
      headless: true,
      instances: [{ browser: "chromium" }],
    },
  },
  resolve: {
    dedupe: ["react", "react-dom"],
    alias: [
      { find: /^react$/, replacement: path.join(reactDir, "index.js") },
      { find: /^react\\/(.*)$/, replacement: path.join(reactDir, "$1") },
      { find: /^react-dom$/, replacement: path.join(reactDomDir, "index.js") },
      { find: /^react-dom\\/(.*)$/, replacement: path.join(reactDomDir, "$1") },
      { find: "@", replacement: path.resolve(import.meta.dirname, "./src") },
    ],
  },
});
'''

SETUP_TS = 'import "@testing-library/jest-dom/vitest";\n'

SETUP_BROWSER_TS = (
    'export {};\n'
    '\n'
    'try {\n'
    '  await import("@/index.css");\n'
    '} catch {}\n'
)

FILES = [
    ("vitest.config.ts", VITEST_CONFIG),
    ("vitest.browser.config.ts", BROWSER_CONFIG),
    ("src/__tests__/setup.ts", SETUP_TS),
    ("src/__tests__/setup.browser.ts", SETUP_BROWSER_TS),
]

DEPS = [
    "vitest", "jsdom",
    "@testing-library/react", "@testing-library/jest-dom", "@testing-library/user-event",
    "@vitest/browser", "@vitest/browser-playwright", "vitest-browser-react", "playwright",
]
DEP_VERSIONS = {
    "vitest": "4.1.10",
    "jsdom": "29.1.1",
    "@testing-library/react": "16.3.2",
    "@testing-library/jest-dom": "6.10.0",
    "@testing-library/user-event": "14.6.4",
    "@vitest/browser": "4.1.10",
    "@vitest/browser-playwright": "4.1.10",
    "vitest-browser-react": "2.2.0",
    "playwright": "1.62.1",
}


def check_deps(root: Path) -> list[str]:
    """用 node 的真实模块解析一次性探测所有依赖，返回缺失列表（而非 ls node_modules）。

    依赖预制为 pnpm 布局，包在 /data/shadcn/node_modules（不在 app 目录父链上）。
    node 运行时能解析到（NODE_PATH / pnpm 软链），所以用 require.resolve 而非文件系统检查。
    """
    script = """
const deps = JSON.parse(process.argv[1]);
const missing = deps.filter((d) => {
  try { require.resolve(d); return false; } catch { return true; }
});
console.log(JSON.stringify(missing));
"""
    r = subprocess.run(
        ["node", "-e", script, json.dumps(DEPS)],
        cwd=str(root), capture_output=True, text=True,
    )
    if r.returncode != 0:
        print(r.stderr.strip(), file=sys.stderr)
        return list(DEPS)
    return json.loads(r.stdout.strip() or "[]")


def install_cmd(missing: list[str]) -> str:
    """环境兜底策略：生成一键后台安装命令，只装缺失的包，用精确版本，跳过 playwright 浏览器下载。"""
    spec = " ".join(f"{d}@{DEP_VERSIONS[d]}" for d in missing)
    return (
        f"PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 nohup pnpm add -D {spec} "
        f"> /tmp/vitest_dep_install.log 2>&1 & "
        f"echo \"installing, pid $!, log=/tmp/vitest_dep_install.log\"; "
        f"sleep 60; tail -5 /tmp/vitest_dep_install.log"
    )


def cmd_check(root: Path) -> int:
    """一条命令探测所有依赖是否可解析"""
    missing = check_deps(root)
    for d in DEPS:
        print(f"  {'✅' if d not in missing else '❌'}  {d}")
    print()
    if missing:
        print("该模板为非 shadcn、app_type 为非 web 类型，其预热层未预制测试依赖，需要安装。")
        print("一键后台安装（内网 registry，跳过 playwright 浏览器下载），装完再补配置：")
        print()
        print(f"  cd {root} && {install_cmd(missing)}")
        print()
        print("装完若日志未见完成，重复上面 sleep+tail 一行再等一轮；就绪后运行 setup_vitest.py 补配置。")
        return 1
    print("✅ 依赖齐全。")
    return 0


def cmd_setup(root: Path) -> int:
    """补齐缺失的配置文件（已存在则跳过，不覆盖）。"""
    created, skipped = [], []
    for rel, content in FILES:
        path = root / rel
        if path.exists():
            skipped.append(rel)
            continue
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
        created.append(rel)
    if created:
        print("已补齐:")
        for f in created:
            print(f"  + {f}")
    if skipped:
        print("已存在（跳过）:")
        for f in skipped:
            print(f"  = {f}")
    print()
    print("配置就绪。直接写 src/__tests__/repro-<bug>.test.tsx，用 npx vitest run --config ... 跑。")
    return 0


def main() -> int:
    """解析命令行参数并执行依赖检查或配置补齐。"""
    parser = argparse.ArgumentParser(description="为旧应用补齐 vitest 配置（依赖默认由平台预制）")
    parser.add_argument("--check", action="store_true", help="探测依赖是否齐全")
    parser.add_argument("--dir", default=".", help="项目根目录，默认当前目录")
    args = parser.parse_args()

    root = Path(args.dir).resolve()
    if not (root / "package.json").exists():
        print(f"ERROR: {root} 下没有 package.json", file=sys.stderr)
        return 1

    return cmd_check(root) if args.check else cmd_setup(root)


if __name__ == "__main__":
    sys.exit(main())
