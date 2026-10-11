#!/usr/bin/env python3
"""Fetch a web page as Markdown via the web-reader gateway (optionally SSE streaming).

Observe:
    {
        "progress",
        "status",   "success" | "failed"  (top-level, now trustworthy)
        "reason",   ok | http_status_content_valid | timeout | network_error | ssl_error |
                    fetch_error | empty_content | error_page | blocked_page
        "this_call": {
            "status", "reason", "http_status", "content_file",
            "content_schema", "content_length", "url", "preview",
            "detail"(optional)
        }
    }
Log:
    <project_root>/outputs/research/research_log.json
    {
        "search": [{"phase", "query", "recency_filter", "status", "reason",
                    "result_count", "valid_url_count", "results":[...], "detail"(opt)}],
        "fetch":  [{"phase", "url", "status", "reason", "http_status",
                    "content_file", "content_length", "detail"(opt)}]
    }
    <project_root>/outputs/research/fetch_{url}.md
    <!-- url: ... -->
    [markdown content]

Rules:
- status=success only when: call succeeded + non-empty content + not an error/blocked page.
- error and blocked pages are detected by title + first 3000 chars; their content is NOT
  written to content_file and status=failed is returned.
- HTTP status is recorded as http_status but does NOT directly determine status.
- Runtime failures (timeout/network/page-detect) do NOT die; structured failed is returned.
- Only preflight errors (bad args, invalid URL scheme, missing API key, bad phase) die.

--phase 硬门与 baidu_search.py 相同（无 JSON / phase 非法 / 越界 / 跳号 /
reflection 未齐 → die，不发起请求）。详见 task_progress.py。
"""

import argparse
import http.client
import json
import os
import re
import signal
import socket
import ssl
import sys
import urllib.error
import urllib.parse
import urllib.request

import task_progress as tp


BASE_URL = "https://36oqjsxjo775h3odjp3eev3y740deicu.lambda-url.us-west-2.on.aws"

# outputs 目录由 task_progress.resolve_output_dir 定位（约定部署路径
# <PROJECT_ROOT>/.skills/<skill>/scripts/ → 上 3 级，cwd 只作兜底），
# 也可用 --output-dir 显式指定。详见 task_progress.py。

CONTENT_PREVIEW_LEN = 2000
FETCH_TIMEOUT = 50  # internal deadline; external harness timeout is 60s

# ── Wall-clock deadline for the entire network phase ────────────────────────
# SIGALRM fires after FETCH_TIMEOUT seconds and raises _FetchDeadlineError.
# This is a BaseException subclass so it is NOT caught by broad `except Exception`
# handlers inside the network block (e.g. the `except Exception` around exc.read()).
# Only available on Unix; on Windows FETCH_TIMEOUT is left to socket timeout only.

class _FetchDeadlineError(BaseException):
    """Raised by SIGALRM handler when the network phase wall-clock deadline fires."""


def _deadline_handler(signum, frame):
    raise _FetchDeadlineError(f"fetch wall-clock deadline exceeded ({FETCH_TIMEOUT}s)")


# ── Page-classification patterns ─────────────────────────────────────────────

_BLOCKED_TITLE_RE = re.compile(
    r"^(just a moment|security verification|human verification|"
    r"access denied|安全验证|请完成安全验证)\s*[.…]*$",
    re.IGNORECASE,
)

_ERROR_TITLE_RE = re.compile(
    r"^(4\d\d\s+\w[\w ]*|page not found|not found|bad gateway|"
    r"service unavailable|too many requests|页面不存在|找不到页面)\s*$",
    re.IGNORECASE,
)

# High-confidence title signals taken from real traces12 pages. Kept
# deliberately narrow so normal article titles are never misclassified:
# titles are split on common separators ("|", "»", "·", spaced dashes) and a
# segment must match a known block/error phrase *exactly*, or the whole title
# must match a specific block/error *shape* regex. This is NOT a generic
# "normal page" heuristic — e.g. "How CAPTCHA Systems Work" and
# "How to Fix Page Not Found Errors in Nginx" stay unclassified.
_TITLE_SEG_SEP = re.compile(r"\s*[|｜»›·–—]\s*|\s+[-–—]\s+")

_BLOCKED_TITLE_SHAPES = (
    re.compile(r"^making sure you.{0,3}re not a bot", re.IGNORECASE),
    re.compile(r"^warning:\s*.*\b(captcha|verification)\b", re.IGNORECASE),
)
_BLOCKED_TITLE_SEGMENTS = {
    "are you a robot",
    "verify you are human",
    "human verification",
}

_ERROR_TITLE_SHAPES = (
    re.compile(r"^error:\s*.*\bnot found\b", re.IGNORECASE),
)
_ERROR_TITLE_SEGMENTS = {
    "page not found",
    "not found",
    "doi not found",
    "404 not found",
}

# Body signals — blocked page (require 2+ hits OR 1 high-confidence phrase)
_BLOCKED_BODY_PHRASES = [
    "are you a robot",
    "please confirm you are human",
    "confirm you are human",
    "cloudflare ray id",
    "enable javascript and cookies to continue",
    "访问被阻断",
    "安全验证",
    "人机验证",
]
# High-confidence single-signal phrases (subset of above)
_BLOCKED_BODY_HIGH_CONFIDENCE = {
    "cloudflare ray id",
    "enable javascript and cookies to continue",
    "访问被阻断",
    "人机验证",
}

_ERROR_BODY_PHRASES = [
    "the requested url was not found",
    "the page you are looking for",
    "页面不存在",
    "该页面不存在",
]


def die(message):
    """打印错误信息并以非零状态退出（仅用于 preflight 错误）。"""
    print(message, file=sys.stderr)
    sys.exit(1)


def iter_sse(response):
    """迭代解析 SSE 响应流，逐条返回 data 字段内容。"""
    for raw_line in response:
        line = raw_line.decode("utf-8", errors="replace").strip()
        if not line or not line.startswith("data:"):
            continue
        data = line[5:].strip()
        if data == "[DONE]":
            break
        yield data


def load_log(research_dir):
    """读取 research_log.json 文件，返回 (path, {search, fetch})。"""
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


def url_to_filename(url):
    """把 URL 中的非字母数字字符压成下划线，生成 fetch_<...>.md 文件名。"""
    safe_url = re.sub(r"[^A-Za-z0-9]+", "_", url).strip("_")
    return f"fetch_{safe_url}.md"


def save_content(research_dir, url, content):
    """把正文写到 fetch_<...>.md（纯 markdown），返回绝对路径。"""
    os.makedirs(research_dir, exist_ok=True)
    path = os.path.join(research_dir, url_to_filename(url))
    with open(path, "w", encoding="utf-8") as f:
        f.write(f"<!-- url: {url} -->\n\n")
        f.write(content)
    return os.path.abspath(path)


def _extract_title(content):
    """Extract the page title, or empty string when none is present.

    Jina Reader emits a line-leading ``Title:`` header before the body, so
    prefer that (within the first ~40 lines); fall back to the first Markdown
    H1. A missing title yields ""; it only strengthens blocked/error detection
    and never forces a normal page to fail.
    """
    for line in content.splitlines()[:40]:
        m = re.match(r"^\s*Title:\s*(.+?)\s*$", line)
        if m:
            return m.group(1).strip()
    m = re.search(r"^#\s+(.+?)\s*$", content, re.MULTILINE)
    return m.group(1).strip() if m else ""


def classify_page(content):
    """Classify page content as ("blocked_page", detail) | ("error_page", detail) | ("ok", None).

    Checks only title + first 3000 chars to avoid false positives from article body.
    """
    title = _extract_title(content)
    prefix = content[:3000].lower()

    if title and _BLOCKED_TITLE_RE.match(title):
        return "blocked_page", f"Blocked-page title detected: {title!r}"
    if title and _ERROR_TITLE_RE.match(title):
        return "error_page", f"Error-page title detected: {title!r}"
    if title:
        low_title = title.lower().strip()
        segments = [s.strip() for s in _TITLE_SEG_SEP.split(low_title) if s.strip()]
        if any(rx.search(title) for rx in _BLOCKED_TITLE_SHAPES) or \
                any(seg in _BLOCKED_TITLE_SEGMENTS for seg in segments):
            return "blocked_page", f"Blocked-page title signal: {title!r}"
        if any(rx.search(title) for rx in _ERROR_TITLE_SHAPES) or \
                any(seg in _ERROR_TITLE_SEGMENTS for seg in segments):
            return "error_page", f"Error-page title signal: {title!r}"

    # Body signals — blocked
    blocked_hits = sum(1 for p in _BLOCKED_BODY_PHRASES if p.lower() in prefix)
    if blocked_hits >= 2:
        return "blocked_page", "Multiple blocked-page body signals detected"
    for phrase in _BLOCKED_BODY_HIGH_CONFIDENCE:
        if phrase.lower() in prefix:
            return "blocked_page", f"Blocked-page body signal: {phrase!r}"

    # Body signals — error page
    for phrase in _ERROR_BODY_PHRASES:
        if phrase.lower() in prefix:
            return "error_page", f"Error-page body signal: {phrase!r}"

    return "ok", None


def main():
    """入口：解析命令行参数，抓取网页内容并输出结果 JSON。"""
    parser = argparse.ArgumentParser(description="Fetch a web page as Markdown and print one JSON result.")
    parser.add_argument("--url", required=True, help="Target page URL.")
    parser.add_argument("--return-format", choices=["markdown", "html", "text", "screenshot", "pageshot"],
                        help="Output format.")
    parser.add_argument("--with-images-summary", action="store_true", help="Append an image summary.")
    parser.add_argument("--with-links-summary", action="store_true", help="Append a link summary.")
    parser.add_argument("--target-selector", help="CSS selector to extract only.")
    parser.add_argument("--remove-selector", help="CSS selector to remove.")
    parser.add_argument("--timeout", type=int, help="Page load timeout in seconds.")
    parser.add_argument("--no-cache", action="store_true", help="Disable cache and force a fresh crawl.")
    parser.add_argument("--stream", action="store_true", help="Use SSE streaming and aggregate chunks.")
    parser.add_argument("--phase", required=True,
                        help="研究任务.json 里的 task-N 或 reflection（不是全局 todo 序号）")
    parser.add_argument("--output-dir",
                        help="outputs 目录绝对路径（默认按脚本位置与 app-<id> 目录自动推断）")
    args = parser.parse_args()

    # ── Preflight checks (die on failure) ────────────────────────────────────
    api_key = os.environ.get("INTEGRATIONS_API_KEY")
    if not api_key:
        die("Missing INTEGRATIONS_API_KEY environment variable")

    # 阶段 4/5 进度硬门（无 JSON / phase 非法 / 越界 / 跳号 / reflection 未齐）：
    # 在发起网络请求前校验，避免违规调用浪费配额。
    output_dir, probed = tp.resolve_output_dir(__file__, args.output_dir)
    research_dir = os.path.join(output_dir, "research")
    log_file, log_data = load_log(research_dir)
    steps, completed_ids = tp.validate_phase_for_research(output_dir, args.phase, log_data, probed)

    # 唯一代码层检索硬停：本任务 search≥30 或 retrieval(search+fetch)≥35，或 reflection 全局
    # retrieval≥90 后，禁止新的 Fetch。改为用已有 evidence 收敛结论 / 记 limitation。
    # 在发起网络请求前校验。
    gate_msg = tp.check_retrieval_hard_gate(args.phase, log_data)
    if gate_msg:
        die(gate_msg)

    # Validate the target URL before constructing the endpoint
    target_url = args.url.strip()
    if not target_url:
        die("--url must not be empty")
    parsed = urllib.parse.urlparse(target_url)
    if parsed.scheme not in ("http", "https"):
        die(f"Invalid URL scheme '{parsed.scheme}': only http/https are supported")
    if not parsed.netloc:
        die(f"Invalid URL (no host): {target_url}")
    # Check hostname labels: IDNA requires each label ≤ 63 chars, non-empty
    hostname = parsed.hostname or ""
    for label in hostname.split("."):
        if not label or len(label) > 63:
            die(
                f"Invalid hostname '{hostname}': DNS label "
                f"'{label[:20]}...' is empty or exceeds 63 characters"
            )

    # Strip userinfo from BASE_URL to avoid IDNA label-too-long errors during
    # urllib's hostname encoding.  The userinfo (if any) is kept for reference
    # but authentication goes through the X-Gateway-Authorization header.
    _parsed_base = urllib.parse.urlsplit(BASE_URL)
    _netloc = _parsed_base.hostname + (f":{_parsed_base.port}" if _parsed_base.port else "")
    _clean_base = urllib.parse.urlunsplit((
        _parsed_base.scheme, _netloc, _parsed_base.path.rstrip("/"), "", ""
    ))
    endpoint = f"{_clean_base}/{urllib.parse.quote(target_url, safe='')}"

    headers = {
        "X-Gateway-Authorization": f"Bearer {api_key}",
        # 网关后端受 Cloudflare 保护，缺少浏览器 UA 会被判定为爬虫返回 403
        "User-Agent": (
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
            "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        ),
    }
    if args.return_format:
        headers["X-Return-Format"] = args.return_format
    if args.with_images_summary:
        headers["X-With-Images-Summary"] = "true"
    if args.with_links_summary:
        headers["X-With-Links-Summary"] = "true"
    if args.target_selector:
        headers["X-Target-Selector"] = args.target_selector
    if args.remove_selector:
        headers["X-Remove-Selector"] = args.remove_selector
    if args.timeout is not None:
        headers["X-Timeout"] = str(args.timeout)
    if args.no_cache:
        headers["X-No-Cache"] = "true"
    headers["Accept"] = "text/event-stream" if args.stream else "text/html"

    request = urllib.request.Request(endpoint, method="GET", headers=headers)

    # ── Network call (soft-fail) ──────────────────────────────────────────────
    content = None
    http_status = None
    error_msg = None
    reason = None

    # Arm wall-clock deadline (Unix only). _FetchDeadlineError is a BaseException
    # so it bypasses all `except Exception` handlers in the network block below.
    _sigalrm_available = hasattr(signal, "SIGALRM")
    _old_handler = None
    if _sigalrm_available:
        _old_handler = signal.signal(signal.SIGALRM, _deadline_handler)
        signal.alarm(FETCH_TIMEOUT)

    try:
        try:
            with urllib.request.urlopen(request, timeout=FETCH_TIMEOUT) as response:
                http_status = response.status
                if args.stream:
                    parts = []
                    for data in iter_sse(response):
                        parts.append(data)
                    content = "".join(parts)
                else:
                    content = response.read().decode("utf-8", errors="replace")
        except TimeoutError as exc:
            reason, error_msg = "timeout", str(exc)
        except urllib.error.HTTPError as exc:
            http_status = exc.code
            # Read the body — it may be the actual page content (e.g. a 404 page with valid text)
            # so pass it through classify_page rather than immediately failing.
            # Only gateway auth errors (401) are hard failures before content inspection.
            if exc.code == 401:
                reason, error_msg = "fetch_error", "HTTP 401: 鉴权失败，JWT Token 缺失或无效"
            else:
                try:
                    body_text = exc.read().decode("utf-8", errors="replace")
                except Exception as read_exc:
                    reason, error_msg = "fetch_error", f"HTTP {exc.code}: failed to read body: {read_exc}"
                    body_text = None
                if body_text is not None:
                    # Detect gateway/API JSON error bodies (e.g. {"code":422,"name":"AssertionFailureError",...})
                    # These are not webpage content; pass them directly to fetch_error.
                    _is_gateway_error = False
                    try:
                        _body_json = json.loads(body_text)
                        if (isinstance(_body_json, dict)
                                and isinstance(_body_json.get("code"), int)
                                and _body_json["code"] == exc.code
                                and isinstance(_body_json.get("name"), str)
                                and _body_json["name"].endswith("Error")):
                            _is_gateway_error = True
                    except (json.JSONDecodeError, ValueError):
                        pass
                    # Detect plain-text gateway error bodies (e.g. HTTP 502 "Internal Server Error").
                    # Only match when body is short and matches a known gateway error string exactly,
                    # to avoid false-positives on real pages that mention server errors in body text.
                    if not _is_gateway_error and exc.code >= 500:
                        _stripped = body_text.strip()
                        _PLAIN_GATEWAY_ERRORS = (
                            "internal server error",
                            "bad gateway",
                            "service unavailable",
                            "gateway timeout",
                        )
                        if len(_stripped) < 200 and _stripped.lower() in _PLAIN_GATEWAY_ERRORS:
                            _is_gateway_error = True
                    if _is_gateway_error:
                        reason, error_msg = "fetch_error", f"HTTP {exc.code}: gateway error: {body_text}"
                    else:
                        content = body_text
        except urllib.error.URLError as exc:
            cause = exc.reason
            if isinstance(cause, (socket.timeout, TimeoutError)):
                reason, error_msg = "timeout", str(cause)
            elif isinstance(cause, ssl.SSLError):
                reason, error_msg = "ssl_error", str(cause)
            else:
                reason, error_msg = "network_error", str(cause)
        except UnicodeError as exc:
            reason, error_msg = "fetch_error", f"Invalid host in URL '{target_url}': {exc}"
        except http.client.HTTPException as exc:
            reason, error_msg = "fetch_error", f"HTTP protocol error: {type(exc).__name__}: {exc}"
        except ssl.SSLError as exc:
            # SSLError raised directly from socket during body read (after headers received)
            reason, error_msg = "ssl_error", str(exc)
        except (ConnectionResetError, ConnectionError, OSError) as exc:
            # Socket/OS errors raised directly during body read
            reason, error_msg = "network_error", f"{type(exc).__name__}: {exc}"
    except _FetchDeadlineError as exc:
        # Wall-clock deadline fired — treat as timeout regardless of which
        # inner operation was in progress. Must be caught outside the inner
        # try/except block so broad `except Exception` cannot intercept it.
        reason, error_msg = "timeout", str(exc)
    finally:
        # Disarm the alarm and restore the previous SIGALRM handler.
        if _sigalrm_available:
            signal.alarm(0)
            signal.signal(signal.SIGALRM, _old_handler)

    # Emit warning only when we actually end up failing (checked again after classify_page)
    # — deferred below, after status is determined

    # ── Page content classification ───────────────────────────────────────────
    if content:
        page_kind, page_detail = classify_page(content)
        if page_kind != "ok":
            if error_msg is None:
                error_msg = page_detail
            reason = page_kind  # "blocked_page" or "error_page"
            content = None

    # ── Status and reason ─────────────────────────────────────────────────────
    if content:
        status = "success"
        if reason is None:
            reason = "ok" if (http_status is None or http_status == 200) else "http_status_content_valid"
    else:
        status = "failed"
        if reason is None:
            reason = "empty_content"

    # ── Save content file (success only; failure here flips status) ──────────
    content_file = None
    if content:
        try:
            content_file = save_content(research_dir, target_url, content)
        except Exception as exc:
            # Can't guarantee content_file is readable — downgrade to failed
            write_err = str(exc)
            print(f"WARNING: 写入 content 文件失败: {write_err}", file=sys.stderr)
            error_msg = f"content file write failed: {write_err}"
            reason = "fetch_error"
            status = "failed"
            content = None  # ensure content_length=0 below

    if status == "failed" and error_msg:
        print(f"WARNING: fetch 失败 {target_url}: {error_msg}", file=sys.stderr)

    # ── Write to research_log.json ────────────────────────────────────────────
    log_entry = {
        "phase": args.phase,
        "url": target_url,
        "status": status,
        "reason": reason,
        "http_status": http_status,
        "content_file": content_file,
        "content_length": len(content) if content else 0,
    }
    if error_msg:
        log_entry["detail"] = error_msg
    log_data["fetch"].append(log_entry)
    try:
        save_log(research_dir, log_file, log_data)
    except Exception as exc:
        print(f"WARNING: 写入 log 文件失败: {exc}", file=sys.stderr)

    # ── Progress (after log write so stats include this call) ─────────────────
    next_step = tp.dynamic_next_step(args.phase, log_data, status, "fetch", steps, completed_ids)
    progress = tp.render_progress_block(
        steps, completed_ids, args.phase, log_data=log_data, next_step=next_step
    )

    # ── Return to LLM ─────────────────────────────────────────────────────────
    this_call = {
        "status": status,
        "reason": reason,
        "http_status": http_status,
        "content_file": content_file,
        "content_schema": "markdown (首行 <!-- url: ... --> 注释)",
        "content_length": len(content) if content else 0,
        "url": target_url,
        "preview": (content or "")[:CONTENT_PREVIEW_LEN],
    }
    if error_msg:
        this_call["detail"] = error_msg
    output = {
        "progress": progress,
        "status": status,
        "reason": reason,
        "log_file": os.path.abspath(log_file),
        "this_call": this_call,
    }
    print(json.dumps(output, ensure_ascii=False))


if __name__ == "__main__":
    main()
