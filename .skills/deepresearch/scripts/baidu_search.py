#!/usr/bin/env python3
"""Call the Baidu AI search (Qianfan ai_search) API and print one JSON result.

Observe:
    {
        "progress", "status", "reason", "log_file", "log_schema",
        "this_call": {"phase", "query",
                      "search_results": [{"url", "title", "date", "website",
                                          "rerank_score", "preview"}]}
    }
    status:  "success" (≥1 valid http/https URL) | "failed" (runtime error or no usable results)
    reason:  ok | empty_results | timeout | rate_limit | network_error | ssl_error |
             invalid_response | config_error | search_error
    detail:  optional debug string (top-level, only on failure)

Log:
    <project_root>/outputs/research/research_log.json
    {
        "search": [{"phase", "query", "recency_filter", "status", "reason",
                    "result_count", "valid_url_count",
                    "results": [{"url", "title", "snippet", "date", "website", ...}],
                    "detail"(optional)}],
        "fetch":  [{"phase", "url", "status", "reason", "http_status",
                    "content_file", "content_length", "detail"(optional)}]
    }

--phase 必须是 研究任务.json 里的 task-N 或 reflection：
- 无 JSON / phase 非法 / N 越界 / 跳号（N-1 既无 log 也无结论文件）→ die，不发起请求。
- --phase reflection 但任务结论未齐（按 conclusions/task_N.md 是否存在判定）→ die。
- 有结论文件的任务即视为 completed（不要求经由 save_conclusion.py 写入），只有指针
  （第一个没有结论文件的任务）才会被标 in_progress；超前的 --phase 只写 log，不改 JSON。
详见 task_progress.py。

Runtime failures (timeout / network / rate_limit / etc.) do NOT die; they return a
structured JSON with status="failed" and write a failed entry to research_log.json.
Only preflight errors (missing API key, bad args, invalid phase) call die().
"""

import argparse
import http.client
import json
import os
import socket
import ssl
import sys
import urllib.error
import urllib.parse
import urllib.request

import task_progress as tp


ENDPOINT = "https://api-rY7JZ6jqr6dL@app-ezvlp6ds1hqa-api-ELbWqrZ1krJY-gateway.miaoda.online/v2/ai_search/chat/completions"

# outputs 目录由 task_progress.resolve_output_dir 定位（约定部署路径
# <PROJECT_ROOT>/.skills/<skill>/scripts/ → 上 3 级，cwd 只作兜底），
# 也可用 --output-dir 显式指定。详见 task_progress.py。

FIXED_TOP_K = 20
SNIPPET_PREVIEW_LEN = 150
SEARCH_TIMEOUT = 40  # internal deadline; must remain below the actual external harness timeout


def die(message):
    """打印错误信息并以非零状态退出（仅用于 preflight 错误）。"""
    print(message, file=sys.stderr)
    sys.exit(1)


def load_log(research_dir):
    """读取 log 文件，返回 (path, {search: [...], fetch: [...]}) 结构。"""
    log_file = os.path.join(research_dir, "research_log.json")
    log_data = {"search": [], "fetch": []}
    if os.path.isfile(log_file):
        try:
            with open(log_file, "r", encoding="utf-8") as f:
                loaded = json.load(f)
            if isinstance(loaded, dict):
                if isinstance(loaded.get("search"), list):
                    log_data["search"] = loaded["search"]
                if isinstance(loaded.get("fetch"), list):
                    log_data["fetch"] = loaded["fetch"]
        except (json.JSONDecodeError, OSError) as exc:
            print(f"WARNING: 读取 log 文件失败，使用新文件: {exc}", file=sys.stderr)
    return log_file, log_data


def save_log(research_dir, log_file, log_data):
    """将 log 数据写回文件。"""
    os.makedirs(research_dir, exist_ok=True)
    with open(log_file, "w", encoding="utf-8") as f:
        json.dump(log_data, f, ensure_ascii=False, indent=2)


def build_search_results(references):
    """保留 API 全部字段，snippet 存完整，剔除 content 字段；过滤掉非 http/https URL。"""
    results = []
    for ref in references:
        url = ref.get("url", "")
        if not url.startswith(("http://", "https://")):
            continue
        entry = {k: v for k, v in ref.items() if k != "content"}
        entry["snippet"] = ref.get("snippet") or ref.get("content", "")
        results.append(entry)
    return results


def count_valid_urls(results):
    """Count results with a valid http/https URL."""
    return sum(1 for r in results if r.get("url", "").startswith(("http://", "https://")))


def main():
    """入口：解析参数，调用搜索接口并输出结果 JSON。"""
    parser = argparse.ArgumentParser(description="Call Baidu AI search and print one JSON result.")
    parser.add_argument("--query", help="Single user query. Ignored when --messages is provided.")
    parser.add_argument("--messages", help="JSON array of {role, content} messages, overrides --query.")
    parser.add_argument("--resource-type", action="append", choices=["web", "video"], default=[],
                         help="Resource type to include, can repeat (web/video).")
    parser.add_argument("--search-recency-filter",
                         help="Time filter for search recency (week/month/semiyear/year). "
                              "Any other value is silently ignored (treated as no filter).")
    parser.add_argument("--phase", required=True,
                         help="研究任务.json 里的 task-N 或 reflection（不是全局 todo 序号）")
    parser.add_argument("--output-dir",
                         help="outputs 目录绝对路径（默认按脚本位置与 app-<id> 目录自动推断）")
    args = parser.parse_args()

    # ── Preflight checks (die on failure) ────────────────────────────────────
    api_key = os.environ.get("INTEGRATIONS_API_KEY")
    if not api_key:
        die("Missing INTEGRATIONS_API_KEY environment variable")

    if args.messages:
        try:
            messages = json.loads(args.messages)
        except json.JSONDecodeError as exc:
            die(f"Invalid JSON for --messages: {exc}")
    elif args.query:
        messages = [{"role": "user", "content": args.query}]
    else:
        die("Either --query or --messages is required")

    # 阶段 4/5 进度硬门（无 JSON / phase 非法 / 越界 / 跳号 / reflection 未齐）：
    # 在发起网络请求前校验，避免违规调用浪费配额。
    output_dir, probed = tp.resolve_output_dir(__file__, args.output_dir)
    research_dir = os.path.join(output_dir, "research")
    log_file, log_data = load_log(research_dir)
    steps, completed_ids = tp.validate_phase_for_research(output_dir, args.phase, log_data, probed)

    # 唯一代码层硬停：本任务 search≥30 或 retrieval(search+fetch)≥35，或 reflection 全局
    # retrieval≥90 后，禁止新的 Search。改为用已有 evidence 收敛结论 / 记 limitation。
    # 在发起网络请求前校验。
    gate_msg = tp.check_retrieval_hard_gate(args.phase, log_data)
    if gate_msg:
        die(gate_msg)

    # Normalize recency filter: only the four documented values are passed to the API;
    # anything else (e.g. "any", "all", "none") is silently treated as no filter.
    _VALID_RECENCY = {"week", "month", "semiyear", "year"}
    recency_filter = args.search_recency_filter if args.search_recency_filter in _VALID_RECENCY else None

    # ── Build request ─────────────────────────────────────────────────────────
    body = {"messages": messages}
    body["resource_type_filter"] = [
        {"type": t, "top_k": FIXED_TOP_K}
        for t in (args.resource_type or ["web"])
    ]
    if recency_filter:
        body["search_recency_filter"] = recency_filter

    # Strip userinfo from ENDPOINT to avoid IDNA label-too-long errors
    _parsed_ep = urllib.parse.urlsplit(ENDPOINT)
    _netloc = _parsed_ep.hostname + (f":{_parsed_ep.port}" if _parsed_ep.port else "")
    _clean_endpoint = urllib.parse.urlunsplit((
        _parsed_ep.scheme, _netloc, _parsed_ep.path, _parsed_ep.query, ""
    ))

    request = urllib.request.Request(
        _clean_endpoint,
        data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
        method="POST",
        headers={
            "Content-Type": "application/json",
            "X-Gateway-Authorization": f"Bearer {api_key}",
        },
    )

    # ── Network call (soft-fail: structured return instead of die) ────────────
    data = None
    reason = None
    error_detail = None
    try:
        with urllib.request.urlopen(request, timeout=SEARCH_TIMEOUT) as response:
            raw = response.read().decode("utf-8", errors="replace")
        try:
            data = json.loads(raw)
        except json.JSONDecodeError as exc:
            reason, error_detail = "invalid_response", f"JSONDecodeError: {exc}"
    except TimeoutError as exc:
        reason, error_detail = "timeout", str(exc)
    except urllib.error.HTTPError as exc:
        body_text = exc.read().decode("utf-8", errors="replace")
        if exc.code == 429:
            reason, error_detail = "rate_limit", f"HTTP 429: {body_text}"
        elif exc.code == 402:
            reason, error_detail = "config_error", "HTTP 402: 账户余额不足"
        else:
            reason, error_detail = "search_error", f"HTTP {exc.code}: {body_text}"
    except urllib.error.URLError as exc:
        cause = exc.reason
        if isinstance(cause, (socket.timeout, TimeoutError)):
            reason, error_detail = "timeout", str(cause)
        elif isinstance(cause, ssl.SSLError):
            reason, error_detail = "ssl_error", str(cause)
        else:
            reason, error_detail = "network_error", str(cause)
    except http.client.HTTPException as exc:
        reason, error_detail = "invalid_response", f"{type(exc).__name__}: {exc}"
    except ssl.SSLError as exc:
        # SSLError raised directly from socket during body read (after headers received)
        reason, error_detail = "ssl_error", str(exc)
    except (ConnectionResetError, ConnectionError, OSError) as exc:
        # Socket/OS errors raised directly during body read
        reason, error_detail = "network_error", f"{type(exc).__name__}: {exc}"

    # ── Determine status / results ────────────────────────────────────────────
    if reason is None:
        # Successful HTTP response — validate usable results
        references = data.get("references", []) if data else []
        search_results = build_search_results(references)
        valid_url_count = count_valid_urls(search_results)
        if not search_results or valid_url_count == 0:
            status, reason = "failed", "empty_results"
            error_detail = "No valid http/https result URL"
        else:
            status, reason = "success", "ok"
    else:
        search_results = []
        valid_url_count = 0
        status = "failed"

    # ── Write to research_log.json ────────────────────────────────────────────
    log_entry = {
        "phase": args.phase,
        "query": args.query or json.dumps(messages, ensure_ascii=False),
        "recency_filter": recency_filter,
        "status": status,
        "reason": reason,
        "result_count": len(search_results),
        "valid_url_count": valid_url_count,
        "results": search_results,
    }
    if error_detail:
        log_entry["detail"] = error_detail
    log_data["search"].append(log_entry)
    try:
        save_log(research_dir, log_file, log_data)
    except Exception as exc:
        print(f"WARNING: 写入 log 文件失败: {exc}", file=sys.stderr)

    # ── Progress (after log write so stats include this call) ─────────────────
    next_step = tp.dynamic_next_step(args.phase, log_data, status, "search", steps, completed_ids)
    progress = tp.render_progress_block(
        steps, completed_ids, args.phase, log_data=log_data, next_step=next_step
    )

    # ── Return to LLM ─────────────────────────────────────────────────────────
    output = {
        "progress": progress,
        "status": status,
        "reason": reason,
        "log_file": os.path.abspath(log_file),
        "log_schema": (
            "{search: [{phase, query, recency_filter, status, reason, result_count, "
            "valid_url_count, results:[{url, title, snippet, date, website, ...}], detail(opt)}], "
            "fetch: [{phase, url, status, reason, http_status, "
            "content_file, content_length, detail(opt)}]}"
        ),
        "this_call": {
            "phase": args.phase,
            "query": args.query or json.dumps(messages, ensure_ascii=False),
            "search_results": [
                {
                    "url": r.get("url", ""),
                    "title": r.get("title", ""),
                    "date": r.get("date", ""),
                    "website": r.get("website", ""),
                    "rerank_score": r.get("rerank_score"),
                    "preview": (r.get("snippet", "") or "")[:SNIPPET_PREVIEW_LEN],
                }
                for r in search_results
            ],
        },
    }
    if error_detail:
        output["detail"] = error_detail
    print(json.dumps(output, ensure_ascii=False))


if __name__ == "__main__":
    main()
