#!/usr/bin/env python3
"""fetch_sample.py — fetch one real data sample to calibrate mock shape.

Usage:
    # Supabase / PostgREST: reads VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY from .env
    python3 scripts/fetch_sample.py \
        --table majors \
        --select "id,name,category_id,code,major_categories(name,disciplines(name))" \
        --limit 1

    # Any HTTP endpoint
    python3 scripts/fetch_sample.py --url "$VITE_SUPABASE_URL/rest/v1/majors?limit=1"

    # Custom .env path (default ./.env)
    python3 scripts/fetch_sample.py --env ./app/.env --table majors --select "*"

Prints the real JSON, a per-field OBJECT/ARRAY shape analysis, and a paste-ready TS mock literal.
Exit: 0 ok; 1 on fetch failure (network / auth / bad field).
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

PROBE_TIMEOUT_S = 20.0


def load_env(env_path: Path) -> dict[str, str]:
    """解析 .env（忽略注释、空行、export 前缀、引号）。取不到返回空 dict。"""
    env: dict[str, str] = {}
    if not env_path.exists():
        return env
    for raw in env_path.read_text(encoding="utf-8", errors="replace").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        line = line.removeprefix("export ").strip()
        if "=" not in line:
            continue
        key, val = line.split("=", 1)
        val = val.strip().strip('"').strip("'")
        env[key.strip()] = val
    return env


def http_get_json(url: str, headers: dict[str, str]) -> object:
    """GET 一个 URL，解析 JSON。绕过环境代理（sandbox 里代理会让 localhost 超时）。"""
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    req = urllib.request.Request(url, headers=headers)
    with opener.open(req, timeout=PROBE_TIMEOUT_S) as resp:
        body = resp.read().decode("utf-8", errors="replace")
    return json.loads(body)


def build_supabase_url(base: str, table: str, select: str, limit: int) -> str:
    """拼接 Supabase/PostgREST 的 REST 查询 URL（select + limit）。"""
    base = base.rstrip("/")
    query = urllib.parse.urlencode({"select": select, "limit": str(limit)})
    return f"{base}/rest/v1/{table}?{query}"


def analyze_shape(value: object, path: str = "$", lines: list[str] | None = None) -> list[str]:
    """递归分析 JSON 形状，重点标注嵌套关联字段是 OBJECT 还是 ARRAY。

    这是脚本的核心价值：肉眼看长 JSON 容易漏，脚本明确告诉你每个
    嵌套字段的读法（.field.name vs .field[0].name）。
    """
    if lines is None:
        lines = []
    if isinstance(value, list):
        lines.append(f"{path:<40} ARRAY(len={len(value)})  → 读法: {path}[0]")
        if value:
            analyze_shape(value[0], f"{path}[0]", lines)
    elif isinstance(value, dict):
        for key, sub in value.items():
            child = f"{path}.{key}"
            if isinstance(sub, dict):
                lines.append(f"{child:<40} OBJECT  → 多对一嵌套，读法: {child}.<子字段>")
                analyze_shape(sub, child, lines)
            elif isinstance(sub, list):
                inner = "标量" if not sub or not isinstance(sub[0], (dict, list)) else "对象"
                lines.append(f"{child:<40} ARRAY(len={len(sub)}, 元素={inner})  → 一对多嵌套，读法: {child}[0]")
                if sub and isinstance(sub[0], (dict, list)):
                    analyze_shape(sub[0], f"{child}[0]", lines)
            else:
                t = type(sub).__name__ if sub is not None else "null"
                lines.append(f"{child:<40} {t}")
    return lines


def to_ts_literal(value: object, indent: int = 0) -> str:
    """把一条真实样本转成可粘贴的 TS 对象字面量（用作 mock 返回值）。"""
    pad = "  " * indent
    pad_in = "  " * (indent + 1)
    if isinstance(value, dict):
        if not value:
            return "{}"
        items = [f"{pad_in}{k}: {to_ts_literal(v, indent + 1)}" for k, v in value.items()]
        return "{\n" + ",\n".join(items) + f"\n{pad}}}"
    if isinstance(value, list):
        if not value:
            return "[]"
        items = [f"{pad_in}{to_ts_literal(v, indent + 1)}" for v in value]
        return "[\n" + ",\n".join(items) + f"\n{pad}]"
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False)
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value)


def main() -> int:
    """解析命令行参数，取一条真实数据样本并输出形状分析与 mock 字面量。"""
    parser = argparse.ArgumentParser(
        description="取一条真实数据样本校准 mock 形状（REPRODUCE 阶段）",
    )
    parser.add_argument("--url", help="任意 HTTP 接口 URL（GET）。给了就忽略 supabase 参数。")
    parser.add_argument("--table", help="Supabase 表名，如 majors")
    parser.add_argument("--select", default="*", help="PostgREST select 表达式，含嵌套关联")
    parser.add_argument("--limit", type=int, default=1, help="取几条，默认 1")
    parser.add_argument("--env", default="./.env", help=".env 路径，默认 ./.env")
    parser.add_argument("--header", action="append", default=[], help="额外 header，如 'Authorization: Bearer xxx'，可多次")
    args = parser.parse_args()

    headers: dict[str, str] = {}
    for h in args.header:
        if ":" in h:
            k, v = h.split(":", 1)
            headers[k.strip()] = v.strip()

    if args.url:
        url = args.url
    else:
        if not args.table:
            print("ERROR: 需要 --url 或 --table 之一", file=sys.stderr)
            return 1
        env = load_env(Path(args.env))
        base = env.get("VITE_SUPABASE_URL") or env.get("SUPABASE_URL")
        key = env.get("VITE_SUPABASE_ANON_KEY") or env.get("SUPABASE_ANON_KEY")
        if not base or not key:
            print(f"ERROR: 在 {args.env} 里找不到 VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY", file=sys.stderr)
            return 1
        url = build_supabase_url(base, args.table, args.select, args.limit)
        headers.setdefault("apikey", key)
        headers.setdefault("Authorization", f"Bearer {key}")

    try:
        data = http_get_json(url, headers)
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:500]
        print(f"ERROR: HTTP {exc.code} — {detail}", file=sys.stderr)
        return 1
    except Exception as exc:
        print(f"ERROR: 取数失败 — {exc}", file=sys.stderr)
        return 1

    sample = data[0] if isinstance(data, list) and data else data

    print("=" * 60)
    print("① 真实返回（一条样本）")
    print("=" * 60)
    print(json.dumps(sample, ensure_ascii=False, indent=2))

    print()
    print("=" * 60)
    print("② 形状分析（嵌套字段是对象还是数组？决定 mock 与读法）")
    print("=" * 60)
    for line in analyze_shape(sample):
        print("  " + line)

    print()
    print("=" * 60)
    print("③ 建议 mock 字面量（把它当 searchXxx() 的 mockResolvedValue）")
    print("=" * 60)
    print("// ⚠️ 这是真实运行时形状——如果和 types.ts 声明冲突，types.ts 就是根因候选")
    print(to_ts_literal(sample))

    return 0


if __name__ == "__main__":
    sys.exit(main())
