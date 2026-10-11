#!/usr/bin/env python3
"""Save, incrementally revise, validate, and optionally render the final report.

This is the only public write entrypoint for the report.  It deliberately differs
from save_conclusion.py: repairable report-level errors are saved before validation
gates rendering, so the same canonical reports/report.md can be repaired in place.
Catastrophic full-write input (wrong main language, missing report skeleton, or an
obvious diagnostic replacement) is rejected before persistence or budget use.

Public modes (report or patch text is read from stdin):

    python save_report.py --write [--min-words N]
    python save_report.py --patch [--min-words N]

No output path is accepted.  Paths are inferred from this script's installed
location.  --min-words sets a hard minimum word count (only when the user's
original request specifies one); without it an advisory 6000-10000 range applies
and never blocks rendering.  At most two content-changing --write calls are allowed (initial creation plus
one full rewrite).  Identical --write calls are idempotent; later revisions use
--patch without a total patch-count limit.

Patch format
============

Markers must appear on their own lines.  A patch may contain multiple operations;
all are applied to an in-memory copy and committed atomically only if every
operation succeeds.

    @@@ REPLACE
    @@@ OLD_STR
    exact old text
    @@@ NEW_STR
    replacement text
    @@@ END

NEW_STR may be empty to delete OLD_STR.  Insertions and section rewrites are
expressed as ordinary replacements by retaining the anchor/heading in NEW_STR.
Every OLD_STR is located against the same report snapshot.  A multi-operation
patch is rejected unless all matches are unique and non-overlapping and their
combined OLD_STR coverage stays below 80% of the current report.

The first saved report freezes the task-conclusion/reflection URL allowlist.
Later source-file changes are reported but cannot authorize new citations.
Out-of-band changes to report.md are backed up and, when possible, restored from
the last script-saved recovery copy before any new input is accepted.

Renderer contract
=================

After all blocking checks pass, this script writes a temporary structured JSON
model and invokes the private sibling script report_renderer.js:

    node report_renderer.js --input <model.json> --output <temporary.docx>

The renderer is not a public Agent action.  It must produce a DOCX matching the
model; this script verifies the OOXML package before publishing report.docx.
Successful rendering still requires the Agent's semantic review before delivery.
"""

from __future__ import annotations

import argparse
import difflib
import hashlib
import html
import json
import os
from pathlib import Path
import re
import select
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit
import zipfile
import xml.etree.ElementTree as ET


# Script location: <project_root>/.skills/deepresearch/scripts/save_report.py
SCRIPT_DIR = Path(__file__).resolve().parent
SKILL_ROOT = SCRIPT_DIR.parent
PROJECT_ROOT = SCRIPT_DIR.parents[2]
OUTPUT_DIR = PROJECT_ROOT / "outputs"
REPORTS_DIR = PROJECT_ROOT / "reports"
REPORT_MD = REPORTS_DIR / "report.md"
REPORT_DOCX = REPORTS_DIR / "report.docx"
STATE_FILE = OUTPUT_DIR / "report_state.json"
BUILD_DIR = OUTPUT_DIR / ".report_build"
CACHE_DIR = OUTPUT_DIR / ".report_cache"
RENDERER = SCRIPT_DIR / "report_renderer.js"

DEFAULT_MIN_WORDS = 6000
DEFAULT_MAX_WORDS = 10000
DEFAULT_MAX_WORD_REMINDERS = 2
DEFAULT_MAX_FULL_WRITES = 2
MAX_PATCH_COVERAGE_RATIO = 0.80
TOC_MAX_ITEMS_WITH_SUBSECTIONS = 20
MAX_EXPLICIT_MIN_WORDS = 1_000_000
RENDER_TIMEOUT_SECONDS = 180
STDIN_WAIT_SECONDS = 3
STATE_SCHEMA_VERSION = 4

EXIT_OK = 0
EXIT_NEEDS_REVISION = 2
EXIT_INPUT_ERROR = 3
EXIT_RENDER_ERROR = 4

URL_RE = re.compile(r"https?://[^\s<>\]\[（），。；：！？“”‘’、]+", re.IGNORECASE)
CITATION_RE = re.compile(r"\[\^([^\]\s]+)\]")
REFERENCE_DEF_RE = re.compile(r"(?m)^\[\^([^\]\s]+)\]:\s*(.+?)\s*$")
HEADING_RE = re.compile(r"(?m)^(#{1,6})\s+(.+?)\s*$")
IMAGE_RE = re.compile(
    r"!\[((?:[^\]]|\](?!\())*)\]\((?:<([^>]+)>|([^\s)]+))(?:\s+[\"']([^\"']*)[\"'])?\)"
)
PLACEHOLDER_RE = re.compile(
    r"\b(?:TODO|TBD|FIXME)\b|待填写|待补充|待完善|\[\s*请填写\s*\]",
    re.IGNORECASE,
)
INTERNAL_ARTIFACT_RE = re.compile(
    r"(?:\btask[_-]\d+\b|outputs[/\\]|conclusions[/\\]task[_-]\d+\.md|"
    r"reflection[/\\]round[_-]\d+\.md|research_log\.json|fetch_[^\s/\\]+\.md)",
    re.IGNORECASE,
)
PATCH_MARKER_RE = re.compile(r"^@@@\s+([A-Z_]+)\s*$")
FETCH_REF_RE = re.compile(r"fetch_[A-Za-z0-9_]+\.md")
FETCH_URL_HEADER_RE = re.compile(r"<!--\s*url:\s*(https?://\S+?)\s*-->", re.IGNORECASE)
FENCED_CODE_RE = re.compile(r"(?ms)^(```|~~~)[^\n]*\n.*?^\1\s*$")
CJK_RE = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff]")
CITATION_HAT_TYPO_RE = re.compile(r"\[\^(\d+)\^\]")

LANGUAGE_LABELS = {
    "zh-CN": {
        "name": "中文",
        "toc": "目录",
        "references": "参考文献",
        "fallback_title": "研究报告",
    },
    "en-US": {
        "name": "English",
        "toc": "Table of Contents",
        "references": "References",
        "fallback_title": "Research Report",
    },
}

TRACKING_QUERY_KEYS = {
    "fbclid",
    "gclid",
    "dclid",
    "msclkid",
    "mc_cid",
    "mc_eid",
    "igshid",
}

ALLOWED_PATCH_OPS = {
    "REPLACE": ("OLD_STR", "NEW_STR"),
}


class ReportError(Exception):
    """Base exception for input and patch failures that must not change files."""


class PatchError(ReportError):
    """Raised when a patch cannot be parsed or applied atomically."""


class InitialReportMissingError(PatchError):
    """Raised when --patch is called but report.md does not exist yet."""


class PatchFormatError(PatchError):
    """Raised when patch markers or fields are malformed."""


class PatchTooLargeError(PatchError):
    """Raised when combined patch OLD_STR coverage reaches the whole-rewrite threshold."""

    def __init__(self, message: str, coverage_ratio: float) -> None:
        """Store the coverage ratio so the handler can direct the correct next action."""
        super().__init__(message)
        self.coverage_ratio = coverage_ratio


class WritePreflightError(ReportError):
    """Raised when --write input is not safe to commit as a full report."""


class StateIntegrityError(ReportError):
    """Raised when internal report state is missing or has been edited."""


# ---------------------------------------------------------------------------
# Action-guard output helper
# ---------------------------------------------------------------------------

_FORBIDDEN_INTERNAL_STATE = "internal_report_state（.report_cache + report_state.json）"


def emit_patch_contract(stream=sys.stderr) -> None:
    """Emit the canonical --patch input contract.

    Invariant: any Code return that tells the agent it may call
    `save_report.py --patch` MUST emit this contract in the same return, so the
    agent never guesses the patch format (and never submits a unified diff).
    """
    print("PATCH_FORMAT:", file=stream)
    for _pl in PATCH_FORMAT_EXAMPLE.splitlines():
        print(f"  {_pl}", file=stream)
    print("OLD_STR_MUST_MATCH_EXACTLY: true", file=stream)
    print("USE_UNIFIED_DIFF: false", file=stream)
    print("PATCH_MULTI_BLOCK_ALLOWED: yes", file=stream)


def _print_action_guard(
    guard: str,
    next_tool: str,
    *,
    forbidden_extra: list[str] | None = None,
    no_user_confirmation: bool = False,
    full_write_consumed: str | None = None,
) -> None:
    """Print a structured ACTION_GUARD block to stderr.

    All error branches that need to constrain agent next-steps MUST call this
    instead of manually printing individual fields, so they stay in sync.
    """
    print(f"ACTION_GUARD: {guard}", file=sys.stderr)
    print(f"NEXT_TOOL: {next_tool}", file=sys.stderr)
    if full_write_consumed is not None:
        print(f"FULL_WRITE_CONSUMED: {full_write_consumed}", file=sys.stderr)
    if no_user_confirmation:
        print("NO_USER_CONFIRMATION: true", file=sys.stderr)
    items = list(forbidden_extra or []) + [_FORBIDDEN_INTERNAL_STATE]
    print("FORBIDDEN: " + " | ".join(items), file=sys.stderr)
    if "--patch" in next_tool:
        emit_patch_contract(sys.stderr)


def classify_finding_scope(message: str) -> str | None:
    """Tag a deterministic mechanical finding as GLOBAL, LOCAL, or None.

    Code only labels the issue's nature and scope; the agent decides whether to
    do a whole rewrite (--write) or a local edit (--patch). Classes that cannot be
    reliably判定 are left untagged (None) rather than forced.
    """
    m = message
    first = m.splitlines()[0] if m else ""
    # GLOBAL: whole-report structural problems, zero-citation, outline violations.
    if "必须有且只有一个一级标题" in m:
        return "GLOBAL"
    if "正文没有使用任何" in m and "引用" in m:
        return "GLOBAL"
    if "没有可用于报告的网页来源 URL" in m:
        return "GLOBAL"
    if "报告存在重复章节编号" in m:
        return "GLOBAL"
    if "报告语言已锁定" in m and ("正文主体为英文" in m or "正文、表格或图片说明仍含较多中文" in m):
        return "GLOBAL"
    if first.startswith("缺少已确认大纲中的章节："):
        rest = first.split("：", 1)[1] if "：" in first else ""
        count = len([item for item in rest.split("、") if item.strip()])
        return "GLOBAL" if count >= 2 else "LOCAL"
    # LOCAL: single localized fixes (one citation/URL/table/section/format issue).
    if first.startswith("参考文献 [^"):
        return "LOCAL"
    if first.startswith("正文引用缺少参考文献定义"):
        return "LOCAL"
    if "引用编号不合法" in m or "引用编号必须是数字" in m or "参考文献编号重复定义" in m:
        return "LOCAL"
    if first.startswith("报告使用了结论/反思材料中未出现的来源"):
        return "LOCAL"
    if first.startswith("章节内容为空"):
        return "LOCAL"
    if "表格" in m and "列数" in m:
        return "LOCAL"
    if first.startswith("存在未完成占位内容"):
        return "LOCAL"
    if first.startswith("正文暴露了内部任务编号"):
        return "LOCAL"
    if "图片" in m:
        return "LOCAL"
    if "所在章节标题不是标准参考文献标题" in m:
        return "LOCAL"
    if "同时存在 `[^n]:` 脚注定义和子弹列表条目" in m:
        return "LOCAL"
    # Single missing core chapter (summary/conclusion/references) is structural but a
    # single insertion — cannot be reliably判定 as whole vs local, so leave untagged.
    return None


class Findings:
    """Collect all report problems so one invocation returns a complete list."""

    def __init__(self) -> None:
        """Initialize empty error/warning lists."""
        self.errors: list[str] = []
        self.warnings: list[str] = []

    def error(self, message: str) -> None:
        """Record a blocking error, deduplicated."""
        if message not in self.errors:
            self.errors.append(message)

    def warn(self, message: str) -> None:
        """Record a non-blocking warning, deduplicated."""
        if message not in self.warnings:
            self.warnings.append(message)


def configure_runtime_paths() -> None:
    """Locate the project by its existing plan without accepting a path argument."""
    global PROJECT_ROOT, OUTPUT_DIR, REPORTS_DIR, REPORT_MD, REPORT_DOCX
    global STATE_FILE, BUILD_DIR, CACHE_DIR

    if (OUTPUT_DIR / "研究任务.json").is_file():
        return

    candidates: list[Path] = []
    cwd = Path.cwd().resolve()
    for probe in (cwd, *cwd.parents):
        if probe.name.startswith("app-"):
            candidates.append(probe)
            break
    candidates.append(cwd)

    selected = next(
        (root for root in candidates if (root / "outputs" / "研究任务.json").is_file()),
        None,
    )
    if selected is None:
        return

    PROJECT_ROOT = selected
    OUTPUT_DIR = selected / "outputs"
    REPORTS_DIR = selected / "reports"
    REPORT_MD = REPORTS_DIR / "report.md"
    REPORT_DOCX = REPORTS_DIR / "report.docx"
    STATE_FILE = OUTPUT_DIR / "report_state.json"
    BUILD_DIR = OUTPUT_DIR / ".report_build"
    CACHE_DIR = OUTPUT_DIR / ".report_cache"


def configure_runtime_paths_for(output_dir) -> None:
    """Bind all runtime paths to an explicit outputs/ directory.

    Used by save_conclusion.py, which imports this module and knows the project
    root deterministically (from --output-dir) rather than by cwd probing.
    """
    global PROJECT_ROOT, OUTPUT_DIR, REPORTS_DIR, REPORT_MD, REPORT_DOCX
    global STATE_FILE, BUILD_DIR, CACHE_DIR

    out = Path(output_dir).resolve()
    PROJECT_ROOT = out.parent
    OUTPUT_DIR = out
    REPORTS_DIR = PROJECT_ROOT / "reports"
    REPORT_MD = REPORTS_DIR / "report.md"
    REPORT_DOCX = REPORTS_DIR / "report.docx"
    STATE_FILE = OUTPUT_DIR / "report_state.json"
    BUILD_DIR = OUTPUT_DIR / ".report_build"
    CACHE_DIR = OUTPUT_DIR / ".report_cache"


def normalize_newlines(text: str) -> str:
    """Normalize all line endings to `\n`."""
    return text.replace("\r\n", "\n").replace("\r", "\n")


def content_hash(text: str) -> str:
    """Return the SHA-256 hex digest of the given text."""
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def render_fingerprint(markdown_digest: str, language: str) -> str:
    """Invalidate cached DOCX when Markdown or render-model code changes."""

    try:
        renderer_digest = hashlib.sha256(RENDERER.read_bytes()).hexdigest()
    except OSError:
        renderer_digest = "renderer-missing"
    try:
        script_digest = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
    except OSError:
        script_digest = "save-report-missing"
    return content_hash(f"{markdown_digest}:{language}:{script_digest}:{renderer_digest}")


def without_fenced_code(text: str) -> str:
    """Strip fenced code blocks so checks skip code content."""
    return FENCED_CODE_RE.sub("", normalize_newlines(text))


def language_from_text(text: str) -> str | None:
    """Classify clearly Chinese- or English-dominant visible text."""

    value = URL_RE.sub(" ", without_fenced_code(text))
    cjk = len(CJK_RE.findall(value))
    latin = len(re.findall(r"[A-Za-z]", value))
    if cjk >= 8 and cjk >= latin * 0.12:
        return "zh-CN"
    if latin >= 30 and cjk <= latin * 0.04:
        return "en-US"
    return None


def explicit_language_from_text(text: str) -> str | None:
    """Read an explicit report-language instruction without treating labels as prose."""

    matches: list[tuple[int, str]] = []
    offset = 0
    language_token = re.compile(
        r"英文|英语|中文|汉语|\benglish\b|\bchinese\b|\ben(?:-us|-gb)?\b|\bzh(?:-cn|-hans)?\b",
        re.I,
    )

    def language_code(value: str) -> str:
        """Map a matched language token to its language code."""
        return "zh-CN" if re.search(r"中文|汉语|\bchinese\b|\bzh", value, re.I) else "en-US"

    relation_patterns = (
        re.compile(
            r"(?:报告|正文|成文|输出)(?:语言)?\s*"
            r"(?:(?:请|须|应|需要|要求|务必|必须)\s*)*"
            r"(?:使用|采用|用|以|为|要|:|：)\s*"
            r"(英文|英语|中文|汉语|english|chinese|en(?:-us|-gb)?|zh(?:-cn|-hans)?)",
            re.I,
        ),
        re.compile(
            r"(?:使用|采用|用|以)\s*"
            r"(英文|英语|中文|汉语|english|chinese|en(?:-us|-gb)?|zh(?:-cn|-hans)?)"
            r"\s*(?:来|进行)?\s*(?:撰写|写|输出|生成)\s*(?:本|该|一份)?\s*"
            r"(?:报告|正文|成文)",
            re.I,
        ),
        re.compile(
            r"(?:撰写|写|生成|输出|提供)\s*(?:一份|本|该)?\s*"
            r"(英文|英语|中文|汉语|english|chinese)\s*(?:版|语言)?\s*"
            r"(?:报告|正文|成文)",
            re.I,
        ),
        re.compile(
            r"\b(?:write|draft|produce|deliver|generate|provide)\s+(?:the\s+|a\s+|an\s+)?"
            r"(?:report|write-up|output)\s+(?:in|using)\s+"
            r"(english|chinese|en(?:-us|-gb)?|zh(?:-cn|-hans)?)\b",
            re.I,
        ),
        re.compile(
            r"\b(?:write|draft|produce|deliver|generate|provide)\s+(?:the\s+|a\s+|an\s+)?"
            r"(english|chinese)(?:[ -]language)?\s+(?:report|write-up|output)\b",
            re.I,
        ),
        re.compile(
            r"\b(?:report|write-up|output)(?:\s+language)?\s+"
            r"(?:is|in|must\s+be|should\s+be)\s+"
            r"(english|chinese|en(?:-us|-gb)?|zh(?:-cn|-hans)?)\b",
            re.I,
        ),
        re.compile(
            r"\b(english|chinese)[ -]language\s+(?:report|write-up|output)\b",
            re.I,
        ),
    )

    for line in normalize_newlines(text).splitlines():
        label = re.search(
            r"报告语言|成文语言|输出语言|report\s+language|output\s+language",
            line,
            re.I,
        )
        if label:
            token = language_token.search(line, label.end())
            if token:
                matches.append((offset + token.start(), language_code(token.group(0))))
        for pattern in relation_patterns:
            for match in pattern.finditer(line):
                token = match.group(1)
                matches.append((offset + match.start(1), language_code(token)))
        offset += len(line) + 1
    return max(matches, default=(0, None), key=lambda item: item[0])[1]


def extract_original_request(text: str) -> str:
    """Extract a labelled original-request section when the wrapper is bilingual metadata."""

    lines = normalize_newlines(text).splitlines()
    start: int | None = None
    for index, line in enumerate(lines):
        heading = re.match(r"^#{1,6}\s+(.+?)\s*$", line)
        if not heading:
            continue
        label = normalize_heading(heading.group(1))
        if label in {
            "用户原始输入", "用户原始问题", "原始问题", "原始请求",
            "originalquery", "originalrequest", "originaluserinput", "userrequest",
        }:
            start = index + 1
            break
    if start is None:
        return ""
    end = next(
        (index for index in range(start, len(lines)) if re.match(r"^#{1,6}\s+", lines[index])),
        len(lines),
    )
    return "\n".join(lines[start:end]).strip()


# ---------------------------------------------------------------------------
# Min-words scope-aware parser
# ---------------------------------------------------------------------------

_LOCAL_SCOPE_RE = re.compile(
    r"(?:摘要|引言|前言|每节|每章|每个|每部分|结论|结语|每段|每篇|"
    r"abstract|introduction|each\s+section|each\s+chapter|"
    r"per\s+section|each\s+part|each\s+paragraph)",
    re.IGNORECASE,
)

# Soft clause boundaries used to narrow scope search to the current clause.
_SOFT_CLAUSE_RE = re.compile(
    r"[,，]|\band\b|\bbut\b|\bor\b|并且|而且|且|但是|但|以及|或者",
    re.IGNORECASE,
)

_GLOBAL_SCOPE_RE = re.compile(
    r"(?:整体|全文|全篇|报告|整篇|全报告|"
    r"report|overall|full\s+report|entire\s+report|whole\s+report)",
    re.IGNORECASE,
)

_MIN_WORDS_PATTERNS = [
    # Chinese: 至少/不少于/最低/最少 N 字
    re.compile(r"(?:至少|不少于|最低|最少)\s*([\d,，]+)\s*字"),
    # English: minimum / at least / no fewer than N words
    re.compile(r"(?:minimum|at\s+least|no\s+fewer\s+than)\s+([\d,]+)\s+words?", re.IGNORECASE),
]


def parse_report_min_words(original_request: str) -> "int | None | str":
    """Parse the user's stated minimum word count for the whole report.

    Returns:
      int          – a single unambiguous report-level minimum
      None         – no minimum stated
      "ambiguous"  – multiple different minimums found; caller should reject

    Algorithm per numeric minimum match:
      1. Strong sentence boundaries (。.!?；;\n) delimit the window — no
         cross-sentence scope contamination.
      2. Within the window, soft boundaries (commas, conjunctions) further
         narrow to the current clause: left region = [last soft boundary,
         match_start); right region = [match_end, next soft boundary).
      3. Find the nearest scope keyword (LOCAL or GLOBAL) across both regions.
      4. Nearest LOCAL → skip; nearest GLOBAL or no scope → accept.
    """
    if not original_request:
        return None

    _SENT_BOUNDARY = "。.！!？?；;\n"

    found: set[int] = set()
    for pat in _MIN_WORDS_PATTERNS:
        for m in pat.finditer(original_request):
            match_start, match_end = m.start(), m.end()

            # Step 1: sentence window.
            prec = original_request[:match_start]
            wstart = -1
            for ch in _SENT_BOUNDARY:
                pos = prec.rfind(ch)
                if pos > wstart:
                    wstart = pos
            wstart_abs = wstart + 1

            foll = original_request[match_end:]
            wend_rel = len(foll)
            for ch in _SENT_BOUNDARY:
                pos = foll.find(ch)
                if pos != -1 and pos < wend_rel:
                    wend_rel = pos
            wend_abs = match_end + wend_rel

            # Step 2: clause regions within window.
            left_text = original_request[wstart_abs:match_start]
            last_soft = None
            for sm in _SOFT_CLAUSE_RE.finditer(left_text):
                last_soft = sm
            left_region_start = wstart_abs + (last_soft.end() if last_soft else 0)

            right_text = original_request[match_end:wend_abs]
            first_soft = _SOFT_CLAUSE_RE.search(right_text)
            right_region_end = match_end + (first_soft.start() if first_soft else len(right_text))

            # Step 3: find nearest scope across both clause regions.
            best_dist: "int | None" = None
            best_kind: "str | None" = None

            for scope_pat, kind in ((_LOCAL_SCOPE_RE, "local"), (_GLOBAL_SCOPE_RE, "global")):
                for km in scope_pat.finditer(original_request[left_region_start:match_start]):
                    dist = match_start - (left_region_start + km.end())
                    if best_dist is None or dist < best_dist:
                        best_dist = dist
                        best_kind = kind
                for km in scope_pat.finditer(original_request[match_end:right_region_end]):
                    dist = match_end + km.start() - match_end  # = km.start() in right region
                    if best_dist is None or dist < best_dist:
                        best_dist = dist
                        best_kind = kind

            # Step 4: classify.
            if best_kind == "local":
                continue
            n_str = m.group(1)
            n = int(re.sub(r"[,，]", "", n_str))
            found.add(n)

    if not found:
        return None
    if len(found) == 1:
        return found.pop()
    return "ambiguous"


def detect_report_language(markdown_hint: str = "") -> str:
    """Lock report language from explicit input, original request, then confirmed outline."""

    configure_runtime_paths()
    original_path = OUTPUT_DIR / "用户原始问题.md"
    original = ""
    if original_path.is_file():
        try:
            original = original_path.read_text(encoding="utf-8")
        except OSError:
            original = ""

    explicit = explicit_language_from_text(original)
    if explicit:
        return explicit

    original_request = extract_original_request(original)
    detected = language_from_text(original_request) if original_request else None
    if detected:
        return detected

    outline_path = OUTPUT_DIR / "报告大纲.md"
    if outline_path.is_file():
        try:
            outline = outline_path.read_text(encoding="utf-8")
            outline_titles = "\n".join(item[1] for item in HEADING_RE.findall(outline))
            detected = language_from_text(outline_titles or outline)
        except OSError:
            detected = None
        if detected:
            return detected

    detected = language_from_text(markdown_hint)
    return detected or "zh-CN"


def utc_now() -> str:
    """Return the current UTC time as an ISO-8601 string."""
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def atomic_write_text(path: Path, text: str) -> None:
    """Write text to path atomically via a temp file + rename."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, raw_tmp = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    tmp = Path(raw_tmp)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp, path)
    finally:
        if tmp.exists():
            tmp.unlink()


def atomic_write_json(path: Path, data: dict) -> None:
    """Write a dict as pretty-printed JSON atomically."""
    atomic_write_text(path, json.dumps(data, ensure_ascii=False, indent=2) + "\n")


def default_state() -> dict:
    """Return a fresh default report_state.json payload."""
    return {
        "schema_version": STATE_SCHEMA_VERSION,
        "word_reminders_used": 0,
        "word_reminders_max": DEFAULT_MAX_WORD_REMINDERS,
        "last_word_reminder_hash": None,
        "explicit_min_words": None,
        "full_writes_used": 0,
        "markdown_hash": None,
        "previous_markdown_hash": None,
        "rendered_hash": None,
        "render_status": "not_rendered",
        "semantic_review_scope": "full",
        "semantic_review_status": None,
        "semantic_review_hash": None,
        "report_language": None,
        "source_snapshot": None,
        "report_inputs_frozen": False,
        "length_gate_released": False,
        "updated_at": None,
        "state_integrity": None,
    }


def state_backup_path() -> Path:
    """Return the path to the internal state backup copy."""
    return CACHE_DIR / "report_state.json"


def state_integrity_digest(state: dict) -> str:
    """Compute a hash over state fields (excluding the digest itself) for tamper detection."""
    payload = {key: value for key, value in state.items() if key != "state_integrity"}
    canonical = json.dumps(
        payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    )
    return content_hash(canonical)


def normalize_loaded_state(loaded: dict) -> dict:
    """Merge a loaded state dict onto the default schema, filling in missing keys."""
    state = default_state()
    for key in state:
        if key in loaded:
            state[key] = loaded[key]
    state["schema_version"] = STATE_SCHEMA_VERSION
    return state


def read_state_copy(path: Path) -> tuple[dict, bool]:
    """Load and integrity-check one state file; returns (state, is_legacy_schema)."""
    try:
        loaded = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise StateIntegrityError("内部报告状态无法读取或解析。") from exc
    if not isinstance(loaded, dict):
        raise StateIntegrityError("内部报告状态格式无效。")

    try:
        schema_version = int(loaded.get("schema_version") or 0)
    except (TypeError, ValueError) as exc:
        raise StateIntegrityError("内部报告状态版本无效。") from exc
    legacy = schema_version < STATE_SCHEMA_VERSION
    if not legacy:
        expected = loaded.get("state_integrity")
        if not isinstance(expected, str) or expected != state_integrity_digest(loaded):
            raise StateIntegrityError("内部报告状态完整性校验失败。")
    return normalize_loaded_state(loaded), legacy


def report_stage_footprint_exists() -> bool:
    """Whether this project has already entered the Report Stage.

    Used to forbid a silent fresh-init when both state copies are gone: a
    rendered document or an internal recovery copy proves the report was
    already in progress, so missing state is corruption/tampering, not a
    first write.
    """
    if REPORT_MD.is_file() or REPORT_DOCX.is_file():
        return True
    if CACHE_DIR.is_dir():
        for name in ("approved_report.md", "previous_report.md"):
            if (CACHE_DIR / name).is_file():
                return True
        if any(CACHE_DIR.glob("out_of_band_report_*.md")):
            return True
    return False


def load_state() -> dict:
    """Load report state from the primary file or its backup, repairing whichever is stale."""
    backup = state_backup_path()
    errors: list[StateIntegrityError] = []
    legacy_states: list[dict] = []
    for path in (STATE_FILE, backup):
        if not path.is_file():
            continue
        try:
            state, legacy = read_state_copy(path)
        except StateIntegrityError as exc:
            errors.append(exc)
            continue
        if legacy:
            legacy_states.append(state)
            continue
        # Prefer a sealed current-schema copy. A valid primary repairs a
        # missing/corrupt backup; a valid backup repairs the primary.
        save_state(state)
        return state

    if legacy_states:
        state = legacy_states[0]
        if REPORT_MD.is_file():
            expected = state.get("markdown_hash")
            current = REPORT_MD.read_text(encoding="utf-8")
            if not isinstance(expected, str) or content_hash(current) != expected:
                raise StateIntegrityError(
                    "旧版内部状态与现有正式报告不一致，不能自动迁移。"
                )
        save_state(state)
        return state

    if REPORT_MD.is_file() or errors:
        raise StateIntegrityError(
            "正式报告已存在，但内部报告状态缺失或无法通过完整性校验。"
        )
    if report_stage_footprint_exists():
        raise StateIntegrityError(
            "检测到报告阶段的历史产物（已渲染文档或内部恢复副本），但内部报告状态已缺失；"
            "为避免把进行中的报告误判为首次写入，拒绝以全新状态初始化。"
            "请从备份恢复 report_state.json，或确认报告阶段产物后再继续。"
        )
    return default_state()


def save_state(state: dict) -> None:
    """Seal state with a fresh integrity digest and write it to primary + backup paths."""
    sealed = normalize_loaded_state(state)
    sealed["updated_at"] = utc_now()
    sealed["state_integrity"] = state_integrity_digest(sealed)
    state.clear()
    state.update(sealed)
    atomic_write_json(state_backup_path(), sealed)
    atomic_write_json(STATE_FILE, sealed)


def approved_report_path() -> Path:
    """Return the path to the last script-approved report copy."""
    return CACHE_DIR / "approved_report.md"


def save_approved_report(markdown: str) -> None:
    """Keep the last report content accepted through this script for recovery."""

    atomic_write_text(approved_report_path(), markdown)


def enforce_report_integrity(state: dict) -> dict | None:
    """Detect out-of-band report edits and restore the last script-saved version."""

    expected_digest = state.get("markdown_hash")
    if not isinstance(expected_digest, str) or not expected_digest:
        if REPORT_MD.is_file():
            raise StateIntegrityError(
                "正式报告已存在，但内部状态没有对应的报告摘要。"
            )
        return None

    current: str | None = None
    if REPORT_MD.is_file():
        current = REPORT_MD.read_text(encoding="utf-8")
        if content_hash(current) == expected_digest:
            approved = approved_report_path()
            if not approved.is_file() or content_hash(
                approved.read_text(encoding="utf-8")
            ) != expected_digest:
                save_approved_report(current)
            return None

    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    backup: Path | None = None
    if current is not None:
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
        backup = CACHE_DIR / f"out_of_band_report_{stamp}.md"
        atomic_write_text(backup, current)

    restored_from: Path | None = None
    for candidate in (approved_report_path(), CACHE_DIR / "previous_report.md"):
        if not candidate.is_file():
            continue
        candidate_text = candidate.read_text(encoding="utf-8")
        if content_hash(candidate_text) == expected_digest:
            atomic_write_text(REPORT_MD, candidate_text)
            restored_from = candidate
            break

    return {
        "backup": backup,
        "restored_from": restored_from,
        "was_missing": current is None,
    }


def read_stdin() -> str:
    """Read and validate report/patch content from stdin, with a short wait timeout."""
    if sys.stdin.isatty():
        raise ReportError(
            "未收到 stdin。报告或补丁必须与命令在同一次调用中传入，不得空运行。"
        )
    if os.name != "nt":
        try:
            readable, _, _ = select.select([sys.stdin], [], [], STDIN_WAIT_SECONDS)
        except (OSError, ValueError):
            readable = [sys.stdin]
        if not readable:
            raise ReportError(
                f"{STDIN_WAIT_SECONDS} 秒内未收到 stdin。报告或补丁必须与命令在同一次调用中传入。"
            )
    value = normalize_newlines(sys.stdin.read())
    if not value.strip():
        raise ReportError("stdin 内容为空。--write 需要完整 Markdown，--patch 需要补丁操作。")
    try:
        value.encode("utf-8")
    except UnicodeEncodeError as exc:
        raise ReportError("stdin 包含无效 Unicode 代理字符，请以 UTF-8 重新传入。") from exc
    return value


def ensure_prerequisites() -> list[str]:
    """Check that outline, task conclusions and reflections all exist before saving."""
    problems: list[str] = []
    outline = OUTPUT_DIR / "报告大纲.md"
    plan_path = OUTPUT_DIR / "研究任务.json"
    conclusion_dir = OUTPUT_DIR / "conclusions"
    reflection_dir = OUTPUT_DIR / "reflection"

    try:
        outline_ready = outline.is_file() and bool(outline.read_text(encoding="utf-8").strip())
    except OSError as exc:
        outline_ready = False
        problems.append(f"无法读取 outputs/报告大纲.md：{exc}")
    if not outline_ready and not any("报告大纲.md" in item for item in problems):
        problems.append("缺少已确认的 outputs/报告大纲.md。")

    conclusions = sorted(conclusion_dir.glob("task_*.md")) if conclusion_dir.is_dir() else []
    try:
        conclusions_ready = bool(conclusions) and all(
            item.read_text(encoding="utf-8").strip() for item in conclusions
        )
    except OSError as exc:
        conclusions_ready = False
        problems.append(f"无法读取任务结论：{exc}")
    if not conclusions_ready and not any("任务结论" in item for item in problems):
        problems.append("缺少非空的 outputs/conclusions/task_*.md。")

    try:
        plan_data = json.loads(plan_path.read_text(encoding="utf-8"))
        steps = plan_data.get("plan", {}).get("steps", [])
        expected_ids = set()
        for step in steps:
            match = re.search(r"\d+", str(step.get("id", "")))
            if match:
                expected_ids.add(int(match.group(0)))
        if not expected_ids:
            problems.append("outputs/研究任务.json 中没有有效研究任务。")
        else:
            present_ids = {
                int(match.group(1))
                for item in conclusions
                if (match := re.fullmatch(r"task_(\d+)\.md", item.name))
                and item.read_text(encoding="utf-8").strip()
            }
            missing_ids = sorted(expected_ids - present_ids)
            if missing_ids:
                problems.append(
                    "研究任务结论未全部完成，缺少："
                    + "、".join(f"task_{item}.md" for item in missing_ids)
                )
    except FileNotFoundError:
        problems.append("缺少 outputs/研究任务.json。")
    except (OSError, json.JSONDecodeError, AttributeError) as exc:
        problems.append(f"无法读取 outputs/研究任务.json：{exc}")

    reflections = sorted(reflection_dir.glob("round_*.md")) if reflection_dir.is_dir() else []
    try:
        reflections_ready = bool(reflections) and all(
            item.read_text(encoding="utf-8").strip() for item in reflections
        )
    except OSError as exc:
        reflections_ready = False
        problems.append(f"无法读取反思结论：{exc}")
    if not reflections_ready and not any("反思结论" in item for item in problems):
        problems.append("缺少非空的 outputs/reflection/round_*.md。")
    return problems


def parse_patch(raw: str) -> list[tuple[str, dict[str, str]]]:
    """Parse `@@@` marker-delimited patch text into a list of (op, fields) operations."""
    lines = normalize_newlines(raw).splitlines(keepends=True)
    operations: list[tuple[str, dict[str, str]]] = []
    index = 0

    while index < len(lines):
        if not lines[index].strip():
            index += 1
            continue
        match = PATCH_MARKER_RE.match(lines[index].rstrip("\n"))
        if not match:
            raise PatchError(f"第 {index + 1} 行应为操作标记（例如 `@@@ REPLACE`）。")
        op = match.group(1)
        if op not in ALLOWED_PATCH_OPS:
            raise PatchError(f"不支持的补丁操作：{op}")
        index += 1
        fields: dict[str, str] = {}
        current_field: str | None = None
        buffer: list[str] = []

        while index < len(lines):
            # Some agents add a visual `@@@` separator before NEW_STR or END.
            # Accept only that narrow, unambiguous legacy shape; a literal
            # `@@@` elsewhere remains part of the exact field text.
            if lines[index].strip() == "@@@" and index + 1 < len(lines):
                next_marker = PATCH_MARKER_RE.match(lines[index + 1].rstrip("\n"))
                if next_marker and next_marker.group(1) in {"NEW_STR", "END"}:
                    index += 1
                    continue
            marker = PATCH_MARKER_RE.match(lines[index].rstrip("\n"))
            if marker:
                name = marker.group(1)
                if current_field is not None:
                    value = "".join(buffer)
                    # Remove only the framing newline immediately before the next
                    # marker.  Any additional leading/trailing blank lines belong
                    # to the requested exact match and must remain significant.
                    if value.endswith("\n"):
                        value = value[:-1]
                    fields[current_field] = value
                    buffer = []
                if name == "END":
                    index += 1
                    break
                if name in ALLOWED_PATCH_OPS:
                    raise PatchError(f"操作 {op} 缺少 `@@@ END`。")
                if name in {"OLD", "NEW"}:
                    raise PatchError(
                        f"字段 `@@@ {name}` 已更名为 `@@@ {name}_STR`，"
                        "请更新补丁格式。"
                    )
                if name in fields:
                    raise PatchError(f"操作 {op} 的字段 {name} 重复。")
                current_field = name
                index += 1
                continue
            if current_field is None:
                raise PatchError(f"操作 {op} 在第 {index + 1} 行缺少字段标记。")
            buffer.append(lines[index])
            index += 1
        else:
            # Item 3: only the final patch block may omit the trailing `@@@ END`.
            # This branch is reached only at EOF, which necessarily means this is
            # the last block — a middle block missing END hits the next op marker
            # first and raises `缺少 @@@ END` above. Treat EOF as an implicit END,
            # but only when a field body was actually opened; a bare op marker with
            # no fields still fails, and any still-missing/empty required fields are
            # rejected by the checks below.
            if current_field is None:
                raise PatchError(f"操作 {op} 缺少 `@@@ END`。")
            value = "".join(buffer)
            if value.endswith("\n"):
                value = value[:-1]
            fields[current_field] = value
            buffer = []

        required = set(ALLOWED_PATCH_OPS[op])
        supplied = set(fields)
        missing = required - supplied
        extra = supplied - required
        if missing:
            raise PatchError(f"操作 {op} 缺少字段：{', '.join(sorted(missing))}")
        if extra:
            raise PatchError(f"操作 {op} 包含未知字段：{', '.join(sorted(extra))}")
        for name in required:
            if name != "NEW_STR" and not fields[name].strip():
                raise PatchError(f"操作 {op} 的字段 {name} 不能为空。")
        operations.append((op, fields))

    if not operations:
        raise PatchError("补丁中没有操作。")
    return operations


PATCH_FORMAT_EXAMPLE = """@@@ REPLACE
@@@ OLD_STR
当前报告中唯一匹配的原文
@@@ NEW_STR
替换后的文本
@@@ END"""


def line_range_for_span(text: str, start: int, end: int) -> tuple[int, int]:
    """Return the 1-based (start_line, end_line) covering a text span."""
    start_line = text.count("\n", 0, start) + 1
    end_probe = max(start, end - 1)
    end_line = text.count("\n", 0, end_probe) + 1
    return start_line, end_line


def all_occurrences(text: str, needle: str) -> list[int]:
    """Return all (possibly overlapping) start indices of needle in text."""
    positions: list[int] = []
    offset = 0
    while True:
        index = text.find(needle, offset)
        if index < 0:
            return positions
        positions.append(index)
        # Advance by one character so overlapping matches are also treated as
        # ambiguous (for example OLD_STR "aa" in "aaa").
        offset = index + 1


def collapse_whitespace(value: str) -> str:
    """Collapse any run of whitespace into a single space and trim."""
    return re.sub(r"\s+", " ", value).strip()


def closest_patch_candidates(text: str, needle: str, limit: int = 3) -> list[str]:
    """Return short diagnostics only; candidates are never applied fuzzily."""

    candidates: dict[tuple[int, int], tuple[float, str]] = {}
    probe = collapse_whitespace(needle)
    if not probe:
        return []

    for match in re.finditer(r"(?m)^.*\S.*$", text):
        candidate = match.group(0)
        score = difflib.SequenceMatcher(
            None, probe[:1200], collapse_whitespace(candidate)[:1200]
        ).ratio()
        candidates[(match.start(), match.end())] = (score, candidate)

    for match in re.finditer(r"(?ms)(?:\A|\n{2,})(.*?)(?=\n{2,}|\Z)", text):
        candidate = match.group(1)
        if not candidate.strip():
            continue
        score = difflib.SequenceMatcher(
            None, probe[:1200], collapse_whitespace(candidate)[:1200]
        ).ratio()
        key = (match.start(1), match.end(1))
        previous = candidates.get(key)
        if previous is None or score > previous[0]:
            candidates[key] = (score, candidate)

    ranked = sorted(
        (
            (score, start, end, candidate)
            for (start, end), (score, candidate) in candidates.items()
            if score >= 0.20
        ),
        reverse=True,
    )[:limit]
    result: list[str] = []
    for rank, (score, start, end, candidate) in enumerate(ranked, 1):
        first_line, last_line = line_range_for_span(text, start, end)
        preview = collapse_whitespace(candidate)
        if len(preview) > 240:
            preview = preview[:237] + "..."
        item = f"lines {first_line}-{last_line}（相似度 {score:.0%}）：{preview}"
        if (
            rank == 1
            and score >= 0.90
            and len(candidate) <= 1200
            and len(all_occurrences(text, candidate)) == 1
        ):
            item += (
                "\nCURRENT_EXACT_TEXT_BEGIN\n"
                + candidate
                + "\nCURRENT_EXACT_TEXT_END"
            )
        result.append(item)
    return result


def patch_match_error(
    text: str,
    needle: str,
    number: int,
    op: str,
    include_candidates: bool = True,
) -> PatchError:
    """Build a diagnostic PatchError for a non-unique or missing OLD_STR match."""
    positions = all_occurrences(text, needle)
    if positions:
        lines = [line_range_for_span(text, item, item + len(needle))[0] for item in positions]
        shown = "、".join(str(item) for item in lines[:10])
        suffix = "……" if len(lines) > 10 else ""
        return PatchError(
            f"第 {number} 个操作 {op} 失败：OLD_STR 出现 {len(positions)} 次，必须唯一。\n"
            f"出现起始行：{shown}{suffix}\n"
            "请增加相邻标题或上下文；补丁未应用。"
        )

    message = [
        f"第 {number} 个操作 {op} 失败：OLD_STR 未找到。",
        "请根据当前文本重新构造 OLD_STR；不会自动进行模糊替换。",
    ]
    if include_candidates:
        candidates = closest_patch_candidates(text, needle)
        if candidates:
            message.append("最接近的当前文本：")
            message.extend(f"  {index}. {item}" for index, item in enumerate(candidates, 1))
    message.append("补丁未应用。")
    return PatchError("\n".join(message))


def apply_patch_with_details(
    original: str, operations: list[tuple[str, dict[str, str]]]
) -> tuple[str, list[dict[str, int]]]:
    """Apply independent exact replacements against one immutable snapshot."""

    snapshot = normalize_newlines(original)
    located: list[dict[str, object]] = []
    errors: list[str] = []
    candidate_diagnostics_used = 0
    candidate_diagnostics_omitted = 0
    for number, (op, fields) in enumerate(operations, 1):
        old = normalize_newlines(fields["OLD_STR"])
        new = normalize_newlines(fields["NEW_STR"])
        if old == new:
            errors.append(
                f"第 {number} 个操作 {op} 失败：OLD_STR 与 NEW_STR 完全相同，"
                "没有可应用的修改。"
            )
            continue
        positions = all_occurrences(snapshot, old)
        if len(positions) != 1:
            include_candidates = len(positions) == 0 and candidate_diagnostics_used < 3
            if len(positions) == 0:
                if include_candidates:
                    candidate_diagnostics_used += 1
                else:
                    candidate_diagnostics_omitted += 1
            message = str(
                patch_match_error(
                    snapshot,
                    old,
                    number,
                    op,
                    include_candidates=include_candidates,
                )
            )
            errors.append(message.removesuffix("补丁未应用。").rstrip())
            continue
        if old.strip() == snapshot.strip():
            errors.append(
                f"第 {number} 个操作 {op} 会替换整篇报告；"
                "--patch 仅用于增量修改。"
            )
            continue
        start = positions[0]
        located.append(
            {
                "number": number,
                "op": op,
                "start": start,
                "end": start + len(old),
                "new": new,
                "old_chars": len(old),
                "new_chars": len(new),
            }
        )

    if errors:
        diagnostic_note = (
            f"\n另有 {candidate_diagnostics_omitted} 个未找到项未展开相似候选，以控制返回长度。"
            if candidate_diagnostics_omitted
            else ""
        )
        raise PatchError(
            f"补丁中有 {len(errors)} 个操作无法应用：\n"
            + "\n\n".join(errors)
            + diagnostic_note
            + "\n全部操作均未应用。"
        )

    ordered = sorted(located, key=lambda item: (int(item["start"]), int(item["end"])))
    for left, right in zip(ordered, ordered[1:]):
        if int(left["end"]) > int(right["start"]):
            raise PatchError(
                f"第 {left['number']}、{right['number']} 个操作的 OLD_STR "
                "在原报告中重叠；请合并为一个 REPLACE。补丁未应用。"
            )

    covered_chars = sum(int(item["end"]) - int(item["start"]) for item in ordered)
    coverage_ratio = covered_chars / max(1, len(snapshot))
    if coverage_ratio >= MAX_PATCH_COVERAGE_RATIO:
        raise PatchTooLargeError(
            f"本次补丁的 OLD_STR 合计覆盖当前报告约 {coverage_ratio:.0%}，"
            f"达到 {MAX_PATCH_COVERAGE_RATIO:.0%} 上限；--patch 仅用于局部增补或修正。"
            "若整体方向、结构或多数章节确需推翻，请在完整写入次数允许时使用 --write。"
            "补丁未应用。",
            coverage_ratio,
        )

    working = snapshot
    for item in reversed(ordered):
        start = int(item["start"])
        end = int(item["end"])
        working = working[:start] + str(item["new"]) + working[end:]

    if not working.strip():
        raise PatchError("补丁会使报告变为空文件，已拒绝。")

    details: list[dict[str, int]] = []
    for item in sorted(located, key=lambda value: int(value["number"])):
        start_line, end_line = line_range_for_span(
            snapshot, int(item["start"]), int(item["end"])
        )
        details.append(
            {
                "number": int(item["number"]),
                "start_line": start_line,
                "end_line": end_line,
                "old_chars": int(item["old_chars"]),
                "new_chars": int(item["new_chars"]),
            }
        )
    return working.rstrip() + "\n", details


def apply_patch(original: str, operations: list[tuple[str, dict[str, str]]]) -> str:
    """Compatibility wrapper for callers that only need the patched Markdown."""

    patched, _ = apply_patch_with_details(original, operations)
    return patched


def parse_headings(markdown: str) -> list[dict]:
    """Extract all headings (level + plain text) outside fenced code blocks."""
    return [
        {"level": len(match.group(1)), "text": strip_inline_markup(match.group(2)).strip()}
        for match in HEADING_RE.finditer(without_fenced_code(markdown))
    ]


def strip_inline_markup(text: str) -> str:
    """Strip Markdown images/links/citations/emphasis, leaving plain text."""
    text = re.sub(r"!\[([^\]]*)\]\([^)]*\)", r"\1", text)
    text = re.sub(r"\[([^\]]+)\]\([^)]*\)", r"\1", text)
    text = CITATION_RE.sub("", text)
    text = re.sub(r"[*_~`]", "", text)
    return html.unescape(text)


def normalize_heading(text: str) -> str:
    """Strip markup, numbering prefixes and punctuation to get a comparable heading key."""
    value = strip_inline_markup(text).strip()
    value = re.sub(r"^第[一二三四五六七八九十百零〇0-9]+[章节部分]\s*", "", value)
    value = re.sub(r"^[（(]?[一二三四五六七八九十百零〇0-9]+[）)]?[、.．:：\s-]+", "", value)
    return re.sub(r"[\s：:、，,。.!！?？（）()《》<>【】\[\]-]+", "", value).lower()


def heading_role(text: str) -> str | None:
    """Return a structural role that should not be treated as an outline chapter."""

    value = normalize_heading(text)
    if value in {
        "摘要", "内容摘要", "执行摘要", "概览",
        "abstract", "summary", "executivesummary", "overview",
    }:
        return "summary"
    if value in {"目录", "内容目录", "contents", "tableofcontents"}:
        return "toc"
    if value in {
        "参考文献", "参考资料", "来源", "references", "bibliography", "sources",
    }:
        return "references"
    if value in {"大纲", "报告大纲", "研究大纲", "outline", "researchoutline", "reportoutline"}:
        return "outline_wrapper"
    return None


def is_conclusion_heading(text: str) -> bool:
    """Return whether a heading reads as a conclusion/recommendation/outlook section."""
    value = normalize_heading(text)
    return any(token in value for token in (
        "结论", "建议", "展望", "conclusion", "recommendation", "outlook",
    ))


def chinese_number(value: str) -> int | None:
    """Convert a digit string or simple Chinese numeral (1-99) to an int."""
    if value.isdigit():
        return int(value)
    digits = {"零": 0, "〇": 0, "一": 1, "二": 2, "三": 3, "四": 4, "五": 5,
              "六": 6, "七": 7, "八": 8, "九": 9}
    if not value or any(char not in digits and char != "十" for char in value):
        return None
    if "十" not in value:
        return digits.get(value)
    left, right = value.split("十", 1)
    tens = digits.get(left, 1) if left else 1
    ones = digits.get(right, 0) if right else 0
    return tens * 10 + ones


def heading_chapter_number(text: str) -> int | None:
    """Extract only an explicit chapter number, avoiding years such as 2010."""

    value = strip_inline_markup(text).strip()
    match = re.match(r"^第\s*([一二三四五六七八九十零〇0-9]+)\s*[章节部分]", value)
    if not match:
        match = re.match(r"^([一二三四五六七八九十零〇]+)\s*[、.．:：)]", value)
    if not match:
        match = re.match(r"^(\d+)\s*[、.．:：)]", value)
    return chinese_number(match.group(1)) if match else None


def select_toc_headings(headings: list[dict]) -> list[dict]:
    """Choose a compact deterministic TOC from final report headings."""

    candidates: list[dict] = []
    current_main_included = False
    for item in headings:
        level = int(item["level"])
        role = heading_role(item["text"])
        if level == 2:
            current_main_included = role not in {"summary", "toc"}
            if current_main_included:
                candidates.append(item)
        elif level == 3 and current_main_included:
            candidates.append(item)
    if len(candidates) <= TOC_MAX_ITEMS_WITH_SUBSECTIONS:
        return candidates
    return [item for item in candidates if int(item["level"]) == 2]


def canonicalize_toc(markdown: str, language: str) -> tuple[str, dict]:
    """Create or refresh a plain Markdown TOC from the final H2/H3 headings."""

    text = normalize_newlines(markdown).rstrip() + "\n"
    headings = parse_headings(text)
    main_count = sum(
        1
        for item in headings
        if item["level"] == 2 and heading_role(item["text"]) not in {"summary", "toc"}
    )
    selected = select_toc_headings(headings)
    meta = {
        "entries": len(selected),
        "levels": "2-3" if any(item["level"] == 3 for item in selected) else "2",
        "generated": False,
    }
    if main_count < 3 and not any(
        item["level"] == 2 and heading_role(item["text"]) == "toc" for item in headings
    ):
        return text, meta

    toc_lines = [
        ("  - " if item["level"] == 3 else "- ") + strip_inline_markup(item["text"]).strip()
        for item in selected
    ]
    lines = text.splitlines()
    heading_rows: list[tuple[int, int, str]] = []
    for index, line in enumerate(lines):
        match = re.match(r"^(#{1,6})\s+(.+?)\s*$", line)
        if match:
            heading_rows.append((index, len(match.group(1)), match.group(2)))

    toc_row = next(
        (row for row in heading_rows if row[1] == 2 and heading_role(row[2]) == "toc"),
        None,
    )
    replacement = ["", *toc_lines, ""]
    if toc_row:
        lines[toc_row[0]] = f"## {LANGUAGE_LABELS[language]['toc']}"
        start = toc_row[0] + 1
        section_end = next(
            (row[0] for row in heading_rows if row[0] > toc_row[0] and row[1] <= 2),
            len(lines),
        )
        # Replace only the leading generated/manual TOC list.  Preserve any
        # following abbreviation table or explanatory note in the same section.
        end = start
        while end < section_end and not lines[end].strip():
            end += 1
        while end < section_end:
            if re.match(r"^\s*[-*+]\s+", lines[end]):
                end += 1
                continue
            if not lines[end].strip():
                next_nonblank = end + 1
                while next_nonblank < section_end and not lines[next_nonblank].strip():
                    next_nonblank += 1
                end = next_nonblank
                if next_nonblank < section_end and re.match(
                    r"^\s*[-*+]\s+", lines[next_nonblank]
                ):
                    continue
            break
        lines[start:end] = replacement
    else:
        h2_rows = [row for row in heading_rows if row[1] == 2]
        insert_at = h2_rows[0][0] if h2_rows else len(lines)
        if h2_rows and heading_role(h2_rows[0][2]) == "summary":
            insert_at = next((row[0] for row in h2_rows[1:]), len(lines))
        lines[insert_at:insert_at] = [f"## {LANGUAGE_LABELS[language]['toc']}", *replacement]
    meta["generated"] = True
    return "\n".join(lines).rstrip() + "\n", meta


def validate_structure(markdown: str, findings: Findings) -> None:
    """Check heading structure, outline coverage, placeholders and leaked artifacts."""
    headings = parse_headings(markdown)
    h1 = [item for item in headings if item["level"] == 1]
    if len(h1) != 1:
        findings.error(f"报告必须有且只有一个一级标题，当前检测到 {len(h1)} 个。")

    if not has_nonempty_summary(markdown):
        findings.error("缺少非空的摘要/概览章节。")
    if not any(is_conclusion_heading(item["text"]) for item in headings):
        findings.error("缺少非空的结论/建议章节。")
    if not any(heading_role(item["text"]) == "references" for item in headings):
        if REFERENCE_DEF_RE.search(markdown):
            findings.error(
                "报告已包含 `[^n]:` 参考文献定义，但所在章节标题不是标准参考文献标题；"
                "请将其重命名为 `## 参考文献`（中文报告）或 `## References`（英文报告），"
                "不要新增额外的参考文献章节。"
            )
        else:
            findings.error("缺少参考文献章节。")

    outline_path = OUTPUT_DIR / "报告大纲.md"
    if outline_path.is_file():
        outline_headings = parse_headings(outline_path.read_text(encoding="utf-8"))
        required = [
            item for item in outline_headings
            if item["level"] == 2 and normalize_heading(item["text"])
            and heading_role(item["text"]) is None
        ]
        present = [
            item for item in headings
            if item["level"] == 2 and normalize_heading(item["text"])
            and heading_role(item["text"]) is None
        ]
        number_rows: dict[int, list[dict]] = {}
        for item in present:
            number = heading_chapter_number(item["text"])
            if number is not None:
                number_rows.setdefault(number, []).append(item)
        duplicates = sorted(number for number, items in number_rows.items() if len(items) > 1)
        if duplicates:
            findings.error("报告存在重复章节编号：" + "、".join(str(item) for item in duplicates))

        present_exact = {normalize_heading(item["text"]) for item in present}
        missing: list[str] = []
        for position, item in enumerate(required):
            wanted = normalize_heading(item["text"])
            if wanted in present_exact:
                continue
            number = heading_chapter_number(item["text"])
            same_number = number_rows.get(number, []) if number is not None else []
            if len(same_number) == 1:
                actual = same_number[0]["text"]
                similarity = difflib.SequenceMatcher(
                    None, wanted, normalize_heading(actual)
                ).ratio()
                if similarity < 0.35:
                    findings.warn(
                        f"已确认大纲第 {number} 章标题“{item['text']}”在报告中写为“{actual}”，"
                        "章节编号一致但措辞差异较大，请在语义检查确认覆盖范围未改变。"
                    )
                continue
            if len(required) == len(present):
                actual = present[position]["text"]
                similarity = difflib.SequenceMatcher(
                    None, wanted, normalize_heading(actual)
                ).ratio()
                if similarity < 0.60:
                    findings.warn(
                        f"已确认大纲章节“{item['text']}”在报告相同位置写为“{actual}”，"
                        "允许标题润色，但请在语义检查确认章节含义和覆盖范围未改变。"
                    )
                continue
            missing.append(item["text"])
        if missing:
            findings.error("缺少已确认大纲中的章节：" + "、".join(missing))

    placeholder = PLACEHOLDER_RE.search(markdown)
    if placeholder:
        findings.error(f"存在未完成占位内容：{placeholder.group(0)}")
    # Image destinations are implementation metadata, not visible report prose.
    # Keep alt text and titles in the scan because the renderer exposes them.
    visible_markdown = IMAGE_RE.sub(
        lambda match: f"{match.group(1)} {match.group(4) or ''}",
        markdown,
    )
    artifact = INTERNAL_ARTIFACT_RE.search(visible_markdown)
    if artifact:
        findings.error(f"正文暴露了内部任务编号或过程文件路径：{artifact.group(0)}")

    validate_nonempty_sections(markdown, findings)
    validate_tables(markdown, findings)


def validate_nonempty_sections(markdown: str, findings: Findings) -> None:
    """Flag any heading whose section body is empty."""
    matches = list(HEADING_RE.finditer(markdown))
    for index, match in enumerate(matches):
        level = len(match.group(1))
        end = len(markdown)
        for candidate in matches[index + 1 :]:
            if len(candidate.group(1)) <= level:
                end = candidate.start()
                break
        body = markdown[match.end() : end]
        if not strip_inline_markup(body).strip() and not IMAGE_RE.search(body):
            findings.error(f"章节内容为空：{strip_inline_markup(match.group(2)).strip()}")


def split_table_row(line: str) -> list[str]:
    """Split a Markdown table row line into trimmed cell strings."""
    value = line.strip()
    if value.startswith("|"):
        value = value[1:]
    if value.endswith("|"):
        value = value[:-1]
    return [cell.strip() for cell in re.split(r"(?<!\\)\|", value)]


def validate_tables(markdown: str, findings: Findings) -> None:
    """Check that each Markdown table's rows have a consistent column count."""
    lines = markdown.splitlines()
    index = 0
    while index + 1 < len(lines):
        if "|" not in lines[index]:
            index += 1
            continue
        separator = split_table_row(lines[index + 1])
        if not separator or not all(re.fullmatch(r":?-{3,}:?", cell) for cell in separator):
            index += 1
            continue
        expected = len(split_table_row(lines[index]))
        if len(separator) != expected:
            findings.error(f"第 {index + 1} 行附近的表格表头与分隔行列数不一致。")
        row = index + 2
        while row < len(lines) and "|" in lines[row] and lines[row].strip():
            if len(split_table_row(lines[row])) != expected:
                findings.error(f"表格第 {row + 1} 行列数与表头不一致。")
            row += 1
        index = row


def has_nonempty_summary(markdown: str) -> bool:
    """Accept a non-empty summary written as a heading, bold label, or colon label."""
    lines = normalize_newlines(markdown).splitlines()

    def label_is_summary(value: str) -> bool:
        """Return whether a heading/label text reads as a summary label."""
        return heading_role(value.rstrip("：:")) == "summary"

    def following_body_is_nonempty(start: int, inline_tail: str = "") -> bool:
        """Return whether the body following a summary label has visible content."""
        body: list[str] = [inline_tail] if inline_tail.strip() else []
        for candidate in lines[start:]:
            if re.match(r"^#{1,6}\s+", candidate):
                break
            body.append(candidate)
        value = "\n".join(body)
        return bool(strip_inline_markup(value).strip() or IMAGE_RE.search(value))

    for index, line in enumerate(lines):
        heading = re.match(r"^#{1,6}\s+(.+?)\s*$", line)
        if heading and label_is_summary(heading.group(1)):
            if following_body_is_nonempty(index + 1):
                return True
            continue

        bold = re.match(r"^\s*\*\*\s*([^*]+?)\s*\*\*\s*(.*)$", line)
        if bold and label_is_summary(bold.group(1).rstrip("：:")):
            tail = bold.group(2).lstrip("：:").strip()
            if following_body_is_nonempty(index + 1, tail):
                return True
            continue

        colon = re.match(r"^\s*([^：:]{1,40})[：:]\s*(.*)$", line)
        if colon and label_is_summary(colon.group(1)):
            if following_body_is_nonempty(index + 1, colon.group(2).strip()):
                return True
    return False


def clean_url_token(raw: str) -> str:
    """Remove Markdown/sentence punctuation captured next to an HTTP URL."""
    value = re.split(r"[（），。；：！？“”‘’]", raw, maxsplit=1)[0]
    # Markdown links can add an unmatched closing parenthesis before trailing
    # prose. Preserve balanced parentheses in URLs such as wiki/Foo_(bar).
    depth = 0
    for index, char in enumerate(value):
        if char == "(":
            depth += 1
        elif char == ")":
            if depth == 0:
                value = value[:index]
                break
            depth -= 1
    return value.rstrip(".,;:!?]}\"'")


def extract_urls(text: str) -> list[str]:
    """Extract and clean all http(s) URLs found in text."""
    return [clean_url_token(match.group(0)) for match in URL_RE.finditer(text)]


def source_links_from_text(text: str) -> list[dict[str, str]]:
    """Extract exact Markdown-link titles and URLs from a saved source artifact."""

    links: list[dict[str, str]] = []
    for match in URL_RE.finditer(text):
        raw_url = clean_url_token(match.group(0))
        prefix = text[max(0, match.start() - 300) : match.start()]
        title_match = re.search(r"\[([^\]\n]{1,240})\]\($", prefix)
        title = title_match.group(1).strip() if title_match else ""
        links.append(
            {
                "title": title,
                "url": raw_url,
                "normalized_url": normalize_url(raw_url),
            }
        )
    return links


def is_placeholder_url(raw: str) -> bool:
    """Return whether a URL is a literal protocol/template example, not a source."""

    return "{" in raw or "}" in raw


def normalize_url(raw: str) -> str:
    """Canonicalize a URL (force https, lowercase host, strip tracking params) for comparison."""
    value = clean_url_token(raw)
    parsed = urlsplit(value)
    scheme = parsed.scheme.lower()
    if scheme in {"http", "https"}:
        # Browsers and models commonly upgrade an otherwise identical URL to
        # HTTPS. Source identity remains strict for host, path and query.
        scheme = "https"
    netloc = parsed.netloc.lower()
    path = parsed.path.rstrip("/") or "/"
    query_items = [
        (key, item_value)
        for key, item_value in parse_qsl(parsed.query, keep_blank_values=True)
        if not key.lower().startswith("utm_") and key.lower() not in TRACKING_QUERY_KEYS
    ]
    query = urlencode(query_items, doseq=True)
    return urlunsplit((scheme, netloc, path, query, ""))


def source_artifact_paths() -> list[Path]:
    """List all task conclusion and reflection Markdown files, sorted."""
    paths: list[Path] = []
    paths.extend(sorted((OUTPUT_DIR / "conclusions").glob("task_*.md")))
    paths.extend(sorted((OUTPUT_DIR / "reflection").glob("round_*.md")))
    return paths


def extract_allowed_urls() -> set[str]:
    """Collect normalized URLs from all source artifacts (current, unfrozen)."""
    urls: set[str] = set()
    for path in source_artifact_paths():
        try:
            content = path.read_text(encoding="utf-8")
        except OSError:
            continue
        urls.update(normalize_url(url) for url in extract_urls(content))
    return urls


def capture_source_snapshot() -> dict:
    """Freeze report-source files and their URL allowlist at first report save."""

    files: list[dict[str, str]] = []
    allowed_urls: set[str] = set()
    source_entries: dict[str, dict[str, str]] = {}
    for path in source_artifact_paths():
        try:
            content = path.read_text(encoding="utf-8")
        except OSError as exc:
            raise ReportError(f"无法读取报告素材 {path}: {exc}") from exc
        files.append(
            {
                "path": path.relative_to(OUTPUT_DIR).as_posix(),
                "sha256": content_hash(content),
            }
        )
        for entry in source_links_from_text(content):
            normalized = entry["normalized_url"]
            allowed_urls.add(normalized)
            if normalized not in source_entries or (
                not source_entries[normalized]["title"] and entry["title"]
            ):
                source_entries[normalized] = entry
    return {
        "captured_at": utc_now(),
        "files": files,
        "allowed_urls": sorted(allowed_urls),
        "sources": [source_entries[key] for key in sorted(source_entries)],
    }


def freeze_report_inputs_at_stage6() -> dict:
    """Capture and persist the frozen source snapshot at the Reflection→Stage6 handoff.

    Idempotent: if inputs are already frozen with a valid snapshot, the existing
    snapshot is returned untouched (no re-capture, no allowlist expansion).
    Raises ReportError if the snapshot cannot be built — callers must NOT emit
    STAGE6_READY when this raises.
    """
    state = load_state()
    existing = state.get("source_snapshot")
    if state.get("report_inputs_frozen") and isinstance(existing, dict):
        return existing

    snapshot = capture_source_snapshot()
    state["source_snapshot"] = snapshot
    state["report_inputs_frozen"] = True
    save_state(state)
    return snapshot


def source_snapshot_allowed_urls(snapshot: object) -> set[str]:
    """Extract the frozen allowed-URL set from a saved source snapshot."""
    if not isinstance(snapshot, dict):
        return set()
    raw_urls = snapshot.get("allowed_urls")
    if not isinstance(raw_urls, list):
        return set()
    return {str(url) for url in raw_urls if isinstance(url, str) and url}


def stage6_source_preflight_problems() -> list[str]:
    """Deterministic Stage6 readiness check to run BEFORE freezing report inputs.

    Fails only on unresolvable fetch-cache provenance: a report-source artifact
    cites a local fetch_*.md whose file is missing or lacks a reliable
    ``<!-- url: ... -->`` header, so the report could never legally cite that
    source once inputs are frozen. Legitimate non-URL research (计算/综合判断/
    本地文档) produces an empty allowlist and is intentionally allowed — this
    check never requires ``allowed_urls > 0``.
    """
    problems: list[str] = []
    research_dir = OUTPUT_DIR / "research"
    for path in source_artifact_paths():
        try:
            content = path.read_text(encoding="utf-8")
        except OSError as exc:
            problems.append(f"无法读取报告素材 {path.name}：{exc}")
            continue
        rel = path.relative_to(OUTPUT_DIR).as_posix()
        for name in dict.fromkeys(FETCH_REF_RE.findall(content)):
            fpath = research_dir / name
            if not fpath.is_file():
                problems.append(f"{rel} 引用了不存在的抓取缓存 {name}，无法解析来源 URL。")
                continue
            try:
                head = fpath.read_text(encoding="utf-8")[:2048]
            except OSError as exc:
                problems.append(f"无法读取抓取缓存 {name}：{exc}")
                continue
            if not FETCH_URL_HEADER_RE.search(head):
                problems.append(
                    f"抓取缓存 {name} 缺少来源 URL 元数据，无法进入报告来源白名单。"
                )
    return problems


def emit_report_source_handoff_error() -> int:
    """Reject a write/patch on an already-frozen state whose source handoff is unusable.

    Distinct from ordinary validation findings: the frozen allowlist is empty
    yet the report needs web citations. This is a frozen legacy / non-repairable
    state — within this already-frozen run there is no automated fix, so the
    guidance is to STOP automated changes and preserve the scene (frozen state,
    conclusions, reflections, internal cache) for external recovery.
    """
    print("REPORT_SOURCE_HANDOFF_ERROR", file=sys.stderr)
    print("SAVED: no", file=sys.stderr)
    print("REPORT_STATUS: UNCHANGED", file=sys.stderr)
    print("REPAIRABLE_IN_REPORT: no", file=sys.stderr)
    print("RESEARCH_STATUS: CLOSED", file=sys.stderr)
    print("REPORT_INPUTS_FROZEN: yes", file=sys.stderr)
    print(
        "ERROR: 报告输入已在 Stage6 冻结，但冻结的来源白名单为空，"
        "报告需要引用的网页来源无法在报告阶段补充。这是研究→报告的来源交接失败（frozen 遗留/不可修复状态），"
        "在当前已冻结的运行内无法自动修复。",
        file=sys.stderr,
    )
    print("AUTO_FIX_AVAILABLE: no", file=sys.stderr)
    print("ACTION_GUARD: STOP_AUTOMATED_CHANGES", file=sys.stderr)
    print(
        "FORBIDDEN: --write | --patch | 修改 conclusion/reflection | "
        "修改或删除 report_state.json/.report_cache 等内部状态",
        file=sys.stderr,
    )
    print(
        "NEXT: 停止自动修改，保留当前现场（冻结状态、结论、反思、内部缓存均不要改动）供外部人工排查恢复；"
        "本次已冻结的运行不再提供修复入口。",
        file=sys.stderr,
    )
    print("INTERACTION_RULE: NO_ASK_USER", file=sys.stderr)
    return EXIT_INPUT_ERROR


def changed_source_artifacts(snapshot: object) -> list[str]:
    """Report source changes without expanding the frozen URL allowlist."""

    if not isinstance(snapshot, dict) or not isinstance(snapshot.get("files"), list):
        return []
    expected = {
        str(item.get("path")): str(item.get("sha256"))
        for item in snapshot["files"]
        if isinstance(item, dict) and item.get("path") and item.get("sha256")
    }
    current: dict[str, str] = {}
    for path in source_artifact_paths():
        try:
            content = path.read_text(encoding="utf-8")
        except OSError:
            continue
        current[path.relative_to(OUTPUT_DIR).as_posix()] = content_hash(content)

    changes: list[str] = []
    for relative_path in sorted(expected.keys() | current.keys()):
        if relative_path not in current:
            changes.append(f"missing:{relative_path}")
        elif relative_path not in expected:
            changes.append(f"added:{relative_path}")
        elif current[relative_path] != expected[relative_path]:
            changes.append(f"modified:{relative_path}")
    return changes


def emit_report_input_changed(changes: list[str]) -> int:
    """Hard-reject a write/patch when frozen source artifacts have changed."""

    print("REPORT_INPUT_CHANGED", file=sys.stderr)
    print("SAVED: no", file=sys.stderr)
    print("REPORT_STATUS: UNCHANGED", file=sys.stderr)
    for change in changes:
        print(f"  {change}", file=sys.stderr)
    print(
        "ERROR: 报告输入已在 Stage6 冻结，但检测到来源素材（任务结论 / 反思）"
        "发生新增、修改或删除；为保证报告与冻结来源一致，本次未修改报告。",
        file=sys.stderr,
    )
    print(
        "NEXT: 请将 conclusions/ 与 reflection/ 下的来源文件恢复为 Stage6 冻结时的内容后重试；"
        "脚本不会扩大来源白名单，也不会重新冻结快照。",
        file=sys.stderr,
    )
    print("INTERACTION_RULE: NO_ASK_USER", file=sys.stderr)
    return EXIT_INPUT_ERROR


def frozen_source_entries(allowed_urls: set[str]) -> list[dict[str, str]]:
    """Recover source titles for legacy snapshots that did not store them."""

    entries: dict[str, dict[str, str]] = {}
    for path in source_artifact_paths():
        try:
            content = path.read_text(encoding="utf-8")
        except OSError:
            continue
        for entry in source_links_from_text(content):
            normalized = entry["normalized_url"]
            if normalized not in allowed_urls or normalized in entries:
                continue
            entries[normalized] = entry
    return [entries[key] for key in sorted(entries)]


def source_snapshot_entries(
    snapshot: object, allowed_urls: set[str]
) -> list[dict[str, str]]:
    """Return frozen source entries from the snapshot, falling back to a legacy recovery."""
    if isinstance(snapshot, dict) and isinstance(snapshot.get("sources"), list):
        entries: list[dict[str, str]] = []
        for raw in snapshot["sources"]:
            if not isinstance(raw, dict):
                continue
            title = raw.get("title")
            url = raw.get("url")
            normalized = raw.get("normalized_url")
            if not all(isinstance(item, str) for item in (title, url, normalized)):
                continue
            if normalized in allowed_urls:
                entries.append(
                    {"title": title, "url": url, "normalized_url": normalized}
                )
        if entries:
            return entries
    return frozen_source_entries(allowed_urls)


def source_candidate_hint(
    raw_url: str,
    report_title: str,
    source_entries: list[dict[str, str]],
) -> str:
    """Offer exact frozen candidates without performing a fuzzy replacement."""

    normalized = normalize_url(raw_url)
    host = urlsplit(normalized).netloc
    scored: list[tuple[float, dict[str, str]]] = []
    for entry in source_entries:
        candidate_url = entry["normalized_url"]
        candidate_title = entry["title"]
        same_host = bool(host) and urlsplit(candidate_url).netloc == host
        url_score = difflib.SequenceMatcher(None, normalized, candidate_url).ratio()
        title_score = 0.0
        if report_title and candidate_title:
            title_score = difflib.SequenceMatcher(
                None,
                collapse_whitespace(report_title).lower(),
                collapse_whitespace(candidate_title).lower(),
            ).ratio()
        score = max(url_score, title_score) + (0.12 if same_host else 0.0)
        if same_host or score >= 0.60:
            scored.append((score, entry))
    scored.sort(key=lambda item: (-item[0], item[1]["normalized_url"]))
    if not scored:
        return ""

    candidates: list[str] = []
    for _, entry in scored[:2]:
        if entry["title"]:
            candidates.append(f"[{entry['title']}] {entry['url']}")
        else:
            candidates.append(entry["url"])
    return "；冻结来源候选（需核对后原样复制）：" + " | ".join(candidates)


# ── citation pipeline helpers ──────────────────────────────────────────────────


def _mask_code_spans(markdown: str) -> tuple[str, list[tuple[int, int]]]:
    """Return the markdown unchanged plus the spans covered by code fences/inline code."""
    protected: list[tuple[int, int]] = []
    for m in FENCED_CODE_RE.finditer(markdown):
        protected.append((m.start(), m.end()))
    for m in re.finditer(r"`[^`\n]*`", markdown):
        protected.append((m.start(), m.end()))
    protected.sort()
    return markdown, protected


def _in_protected(pos: int, protected: list[tuple[int, int]]) -> bool:
    """Return whether pos falls inside one of the protected (code) spans."""
    for s, e in protected:
        if s > pos:
            break
        if s <= pos < e:
            return True
    return False


def normalize_citation_syntax(markdown: str) -> tuple[str, bool]:
    """Fix [^N^] → [^N] for pure-digit hat typos only; skips code spans and fenced blocks."""
    if not CITATION_HAT_TYPO_RE.search(markdown):
        return markdown, False
    _, protected = _mask_code_spans(markdown)
    changed = False
    result: list[str] = []
    prev = 0
    for m in CITATION_HAT_TYPO_RE.finditer(markdown):
        if _in_protected(m.start(), protected):
            result.append(markdown[prev:m.end()])
        else:
            result.append(markdown[prev:m.start()])
            result.append(f"[^{m.group(1)}]")
            changed = True
        prev = m.end()
    result.append(markdown[prev:])
    return "".join(result), changed


def renumber_citations(markdown: str) -> tuple[str, bool]:
    """Renumber citations using References list physical order as the sole source of truth."""
    _, protected = _mask_code_spans(markdown)
    def_ids_seen: set[str] = set()
    ordered_ids: list[str] = []
    for m in REFERENCE_DEF_RE.finditer(markdown):
        if _in_protected(m.start(), protected):
            continue
        def_id = m.group(1)
        if def_id not in def_ids_seen:
            ordered_ids.append(def_id)
            def_ids_seen.add(def_id)
    if not ordered_ids:
        return markdown, False
    old_to_new: dict[str, str] = {old_id: str(i) for i, old_id in enumerate(ordered_ids, 1)}
    if all(old == new for old, new in old_to_new.items()):
        return markdown, False
    output_lines: list[str] = []
    pos = 0
    for line in markdown.splitlines(keepends=True):
        line_in_protected = _in_protected(pos, protected)
        stripped = line.rstrip("\r\n")
        fm = REFERENCE_DEF_RE.fullmatch(stripped)
        if fm and not line_in_protected:
            new_id = old_to_new.get(fm.group(1), fm.group(1))
            ending = line[len(stripped):]
            output_lines.append(f"[^{new_id}]: {fm.group(2)}{ending}")
        elif not line_in_protected:
            def rewrite_cite(m: re.Match) -> str:
                """Replace a citation marker's old ID with its renumbered ID."""
                return f"[^{old_to_new.get(m.group(1), m.group(1))}]"
            output_lines.append(CITATION_RE.sub(rewrite_cite, line))
        else:
            output_lines.append(line)
        pos += len(line)
    new_markdown = "".join(output_lines)
    return new_markdown, new_markdown != markdown


def _citation_precheck(
    markdown: str, frozen_urls: "set[str] | None" = None
) -> list[str]:
    """Structural + source authorization checks before renumber.

    If any blocker, renumber should be skipped; errors include original IDs.
    """
    _, protected = _mask_code_spans(markdown)
    errors: list[str] = []
    definition_counts: dict[str, int] = {}
    definition_urls: dict[str, list[str]] = {}
    for m in REFERENCE_DEF_RE.finditer(markdown):
        if _in_protected(m.start(), protected):
            continue
        ref_id = m.group(1)
        definition_counts[ref_id] = definition_counts.get(ref_id, 0) + 1
        urls = URL_RE.findall(m.group(2))
        definition_urls.setdefault(ref_id, []).extend(urls)
    # Detect bare [^] (empty ID) outside code spans — must be a malformed citation.
    _EMPTY_CITATION_RE = re.compile(r"\[\^\]")
    if any(
        m
        for m in _EMPTY_CITATION_RE.finditer(markdown)
        if not _in_protected(m.start(), protected)
    ):
        errors.append("引用格式错误：正文或参考文献中存在空编号 [^]（阻塞自动重编）")
    duplicate_ids = sorted(k for k, v in definition_counts.items() if v > 1)
    if duplicate_ids:
        errors.append("参考文献编号重复定义（阻塞自动重编）：" + "、".join(duplicate_ids))
    body_without_defs = REFERENCE_DEF_RE.sub("", markdown)
    body_ids: set[str] = set()
    for m in CITATION_RE.finditer(body_without_defs):
        if not _in_protected(m.start(), protected):
            body_ids.add(m.group(1))
    all_ids = body_ids | set(definition_counts)
    non_numeric = sorted(ref_id for ref_id in all_ids if not ref_id.isdigit())
    if non_numeric:
        errors.append("引用编号含非数字 ID（阻塞自动重编）：" + "、".join(non_numeric))
    missing = sorted(body_ids - set(definition_counts))
    if missing:
        errors.append("正文引用缺少参考文献定义（阻塞自动重编）：" + "、".join(missing))
    if frozen_urls is not None:
        unauthorized: list[str] = []
        for ref_id, urls in definition_urls.items():
            for url in urls:
                normalized = url.rstrip(".,;:!?\"'")
                if normalized not in frozen_urls:
                    unauthorized.append(f"[^{ref_id}] {normalized}")
        if unauthorized:
            errors.append(
                "参考文献 URL 不在冻结来源中（阻塞自动重编）：" + "；".join(unauthorized)
            )
    return errors


def validate_citations(
    markdown: str,
    findings: Findings,
    allowed_urls: set[str] | None = None,
    source_entries: list[dict[str, str]] | None = None,
) -> list[dict]:
    """Check citation markers, reference definitions and URL authorization."""
    definitions: dict[str, str] = {}
    duplicate_ids: set[str] = set()
    for match in REFERENCE_DEF_RE.finditer(markdown):
        ref_id, value = match.group(1), match.group(2).strip()
        if ref_id in definitions:
            duplicate_ids.add(ref_id)
        definitions[ref_id] = value
    if duplicate_ids:
        findings.error("参考文献编号重复定义：" + "、".join(sorted(duplicate_ids)))

    body_without_defs = REFERENCE_DEF_RE.sub("", markdown)
    used = CITATION_RE.findall(body_without_defs)
    used_ids = set(used)
    if not used_ids:
        findings.error("正文没有使用任何 `[^n]` 引用。")
    non_numeric = sorted(ref_id for ref_id in used_ids | set(definitions) if not ref_id.isdigit())
    if non_numeric:
        hat_ids = [ref_id for ref_id in non_numeric if "^" in ref_id]
        plain_ids = [ref_id for ref_id in non_numeric if "^" not in ref_id]
        for bad_id in hat_ids:
            cleaned = bad_id.replace("^", "")
            if cleaned.isdigit():
                findings.error(
                    f"引用编号不合法：[^{bad_id}] 含有多余的 '^'。\n"
                    f"  CITATION_FORMAT_ERROR\n"
                    f"  Detected:  [^{bad_id}]\n"
                    f"  Expected body citation:  [^{cleaned}]\n"
                    f"  Expected definition:  [^{cleaned}]: 来源标题 https://..."
                )
            else:
                findings.error(
                    f"引用编号不合法：[^{bad_id}] 含有多余的 '^' 且编号非数字。\n"
                    f"  CITATION_FORMAT_ERROR\n"
                    f"  Detected:  [^{bad_id}]\n"
                    f"  Expected body citation:  [^1]\n"
                    f"  Expected definition:  [^1]: 来源标题 https://..."
                )
        if plain_ids:
            findings.error("引用编号必须是数字：" + "、".join(plain_ids))
    missing = sorted(used_ids - set(definitions))
    if missing:
        findings.error("正文引用缺少参考文献定义：" + "、".join(missing))
    unused = sorted(set(definitions) - used_ids)
    if unused:
        findings.warn("存在正文未使用的参考文献：" + "、".join(unused))

    if allowed_urls is None:
        allowed_urls = extract_allowed_urls()
    if source_entries is None:
        source_entries = frozen_source_entries(allowed_urls)
    if definitions and not allowed_urls:
        findings.error("任务结论和反思材料中没有可用于报告的网页来源 URL。")
    references: list[dict] = []
    for ref_id, value in definitions.items():
        urls = extract_urls(value)
        if not urls:
            findings.error(f"参考文献 [^{ref_id}] 缺少 http(s) URL。")
        elif not value[: value.find(urls[0])].strip(" —–-:："):
            findings.error(f"参考文献 [^{ref_id}] 缺少来源标题。")
        for url in urls:
            if is_placeholder_url(url):
                findings.error(
                    f"参考文献 [^{ref_id}] 使用了占位 URL，必须替换为任务结论/反思中的完整来源：{url}"
                )
                continue
            normalized = normalize_url(url)
            if allowed_urls and normalized not in allowed_urls:
                title = value[: value.find(url)].strip(" —–-:：")
                hint = source_candidate_hint(url, title, source_entries)
                findings.error(
                    f"参考文献 [^{ref_id}] 使用了结论/反思材料中未出现的来源：{url}{hint}"
                )
        references.append({"id": ref_id, "text": value, "urls": urls})

    report_urls = {
        normalize_url(url): url
        for url in extract_urls(body_without_defs)
        if not is_placeholder_url(url)
    }
    for normalized, raw_url in report_urls.items():
        if allowed_urls and normalized not in allowed_urls:
            hint = source_candidate_hint(raw_url, "", source_entries)
            findings.error(f"报告使用了结论/反思材料中未出现的来源：{raw_url}{hint}")
    references.sort(
        key=lambda item: (0, int(item["id"])) if item["id"].isdigit() else (1, item["id"])
    )

    # Fix A2: detect dual-bibliography schema conflict
    if definitions:
        all_blocks = paragraph_blocks(markdown)
        in_refs_section = False
        ref_list_items: list[str] = []
        for block in all_blocks:
            if block.get("type") == "heading":
                in_refs_section = heading_role(str(block.get("markdown", ""))) == "references"
            elif in_refs_section and block.get("type") == "list_item":
                ref_list_items.append(str(block.get("markdown", ""))[:60])
        if ref_list_items:
            findings.error(
                "参考文献章节同时存在 `[^n]:` 脚注定义和子弹列表条目，会生成两套 bibliography；"
                "请只保留 `[^n]:` 脚注格式，删除所有子弹列表行。"
                f"（检测到的列表条目示例：{ref_list_items[0]!r}）"
            )

    # Fix B: warn on citation laundering (same URL reused ≥3 times)
    url_ref_count: dict[str, int] = {}
    for ref in references:
        for url in ref.get("urls", []):
            key = normalize_url(url)
            url_ref_count[key] = url_ref_count.get(key, 0) + 1
    for url, count in url_ref_count.items():
        if count >= 3:
            findings.warn(
                f"来源 {url} 在参考文献中被 {count} 个编号引用；"
                "请核查这些引用是否都真实出自该来源，"
                "而不是将同一来源复用于不同 claims（citation laundering）。"
            )

    return references


def resolve_local_image(raw_path: str) -> Path | None:
    """Resolve a Markdown image path to a project-local Path, or None if remote."""
    if re.match(r"^[a-z]+://", raw_path, re.IGNORECASE):
        return None
    candidate = Path(raw_path)
    if not candidate.is_absolute():
        candidate = (REPORTS_DIR / candidate).resolve()
    else:
        candidate = candidate.resolve()
    try:
        candidate.relative_to(PROJECT_ROOT.resolve())
    except ValueError as exc:
        raise ReportError(f"图片路径必须位于项目目录内：{raw_path}") from exc
    return candidate


def validate_images(markdown: str, findings: Findings) -> list[dict]:
    """Check each image is on its own line, has alt text, and resolves to an existing local file."""
    images: list[dict] = []
    for match in IMAGE_RE.finditer(markdown):
        alt = match.group(1).strip()
        raw_path = match.group(2) or match.group(3)
        title = (match.group(4) or "").strip()
        line_start = markdown.rfind("\n", 0, match.start()) + 1
        line_end = markdown.find("\n", match.end())
        if line_end < 0:
            line_end = len(markdown)
        if markdown[line_start:line_end].strip() != match.group(0).strip():
            findings.error(
                f"图片必须使用独占一行的 Markdown 图片语法：{raw_path}"
            )
        if not alt:
            findings.error(f"图片缺少说明文字：{raw_path}")
        try:
            resolved = resolve_local_image(raw_path)
        except ReportError as exc:
            findings.error(str(exc))
            continue
        if resolved is None:
            findings.error(f"报告不得直接嵌入远程图片，请先保存为项目内文件：{raw_path}")
            continue
        if not resolved.is_file():
            # For relative paths only: check if the file exists relative to PROJECT_ROOT
            # (common mistake: using outputs/chart.png instead of ../outputs/chart.png)
            suggested_part = ""
            if not Path(raw_path).is_absolute():
                try:
                    alt_candidate = (PROJECT_ROOT / raw_path).resolve()
                    alt_candidate.relative_to(PROJECT_ROOT.resolve())  # containment check
                    if alt_candidate.is_file():
                        suggested = os.path.relpath(alt_candidate, start=REPORTS_DIR)
                        suggested = suggested.replace("\\", "/")
                        suggested_part = f"\n  SUGGESTED_PATH: {suggested}"
                except (ValueError, OSError):
                    pass
            findings.error(
                f"图片文件不存在：{raw_path}"
                f"（save_report.py 以 REPORTS_DIR 为基准解析相对路径）"
                + suggested_part
            )
        images.append(
            {
                "alt": alt,
                "title": title,
                "source": raw_path,
                "resolved_path": str(resolved),
            }
        )
    return images


def visible_text_for_language_check(markdown: str) -> str:
    """Keep reader-visible prose while removing URLs, reference definitions and paths."""

    text = without_fenced_code(markdown)
    text = REFERENCE_DEF_RE.sub(" ", text)
    text = IMAGE_RE.sub(lambda match: f" {match.group(1)} {match.group(4) or ''} ", text)
    text = re.sub(r"\[([^\]]+)\]\([^)]*\)", r"\1", text)
    text = URL_RE.sub(" ", text)
    return text


def validate_language_consistency(markdown: str, findings: Findings, language: str) -> None:
    """Block whole-report language drift and mixed Chinese structural labels."""

    headings = parse_headings(markdown)
    wrong_headings: list[str] = []
    if language == "en-US":
        wrong_headings = [
            item["text"]
            for item in headings
            if english_heading_has_disallowed_cjk(item["text"])
        ]
    else:
        # English product names are valid inside Chinese headings.  Only flag a report
        # whose complete heading system has drifted to English.
        substantial = [item["text"] for item in headings if item["level"] <= 3]
        if substantial and not any(CJK_RE.search(item) for item in substantial):
            latin = sum(len(re.findall(r"[A-Za-z]", item)) for item in substantial)
            if latin >= 30:
                wrong_headings = substantial
    if wrong_headings:
        sample = "；".join(wrong_headings[:6])
        more = f"（另有 {len(wrong_headings) - 6} 项）" if len(wrong_headings) > 6 else ""
        findings.error(
            f"报告语言已锁定为 {LANGUAGE_LABELS[language]['name']}，但章节标题语言不一致："
            f"{sample}{more}"
        )

    visible = visible_text_for_language_check(markdown)
    cjk = len(CJK_RE.findall(visible))
    latin = len(re.findall(r"[A-Za-z]", visible))
    if language == "en-US" and cjk >= 20 and cjk / max(1, cjk + latin) >= 0.02:
        snippets = []
        for number, line in enumerate(visible.splitlines(), 1):
            if CJK_RE.search(line):
                snippets.append(f"第 {number} 行“{line.strip()[:50]}”")
            if len(snippets) == 4:
                break
        findings.error(
            "报告语言已锁定为 English，但正文、表格或图片说明仍含较多中文："
            + "；".join(snippets)
        )
    if language == "zh-CN" and latin >= 300 and cjk / max(1, cjk + latin) < 0.03:
        findings.error("报告语言已锁定为中文，但正文主体为英文；请用中文完整成文。")


def english_heading_has_disallowed_cjk(text: str) -> bool:
    """Allow short CJK aliases in parentheses inside an English heading."""

    if not CJK_RE.search(text):
        return False
    outside = re.sub(r"[（(][^（）()]*[）)]", "", text)
    if len(re.findall(r"[A-Za-z]", outside)) < 4:
        return True

    def keep_or_remove(match: re.Match[str]) -> str:
        """Blank out a parenthetical alias if it's a short CJK gloss, else keep it."""
        inner = match.group(0)[1:-1].strip()
        cjk = len(CJK_RE.findall(inner))
        if 1 <= cjk <= 8 and len(inner) <= 24 and not re.search(r"[。！？；：]", inner):
            return " "
        return match.group(0)

    cleaned = re.sub(r"[（(][^（）()]*[）)]", keep_or_remove, text)
    return bool(CJK_RE.search(cleaned))


def strip_for_word_count(markdown: str) -> tuple[str, list[str]]:
    """Strip TOC/code/headings/links/tables markup and dedupe paragraphs for a word-count pass."""
    text = normalize_newlines(markdown)
    text = re.sub(
        r"(?ms)^##\s+(?:目录|内容目录|Table\s+of\s+Contents|Contents)\s*$.*?(?=^##\s+|\Z)",
        "\n",
        text,
    )
    text = re.sub(r"(?ms)^```.*?^```\s*$", " ", text)
    text = re.sub(r"(?ms)^~~~.*?^~~~\s*$", " ", text)
    text = REFERENCE_DEF_RE.sub(" ", text)
    text = re.sub(r"(?m)^#{1,6}\s+.*$", " ", text)
    text = IMAGE_RE.sub(lambda m: f" {m.group(1)} ", text)
    text = re.sub(r"\[([^\]]+)\]\([^)]*\)", r"\1", text)
    text = CITATION_RE.sub(" ", text)
    text = URL_RE.sub(" ", text)
    text = re.sub(r"(?m)^\s*\|?\s*:?-{3,}:?(?:\s*\|\s*:?-{3,}:?)+\s*\|?\s*$", " ", text)
    text = re.sub(r"[*_~`>#|]", " ", text)

    paragraphs = [re.sub(r"\s+", " ", item).strip() for item in re.split(r"\n\s*\n", text)]
    seen: set[str] = set()
    duplicates: list[str] = []
    unique: list[str] = []
    for paragraph in paragraphs:
        if not paragraph:
            continue
        signature = re.sub(r"\s+", "", paragraph).lower()
        if len(signature) >= 80 and signature in seen:
            duplicates.append(paragraph[:60])
            continue
        seen.add(signature)
        unique.append(paragraph)
    return "\n".join(unique), duplicates


def count_effective_words(markdown: str, findings: Findings) -> int:
    """Count Chinese characters plus English words after stripping non-prose markup."""
    text, duplicates = strip_for_word_count(markdown)
    if duplicates:
        findings.warn(f"检测到 {len(duplicates)} 个重复正文段落，重复部分未计入有效字数。")
    chinese = len(re.findall(r"[\u3400-\u4dbf\u4e00-\u9fff]", text))
    english = len(re.findall(r"\b[A-Za-z]+(?:[-'][A-Za-z]+)*\b", text))
    return chinese + english


def validate_report(
    markdown: str,
    language: str,
    allowed_urls: set[str] | None = None,
    source_entries: list[dict[str, str]] | None = None,
) -> tuple[Findings, dict]:
    """Run all structure/language/citation/image checks and return findings plus details."""
    findings = Findings()
    check_markdown = without_fenced_code(markdown)
    validate_structure(check_markdown, findings)
    validate_language_consistency(check_markdown, findings, language)
    references = validate_citations(
        check_markdown, findings, allowed_urls, source_entries
    )
    images = validate_images(check_markdown, findings)
    effective_words = count_effective_words(markdown, findings)
    details = {
        "effective_words": effective_words,
        "references": references,
        "images": images,
        "headings": parse_headings(markdown),
    }
    return findings, details


def write_preflight_problems(
    markdown: str,
    language: str,
    previous_markdown: str | None = None,
) -> list[str]:
    """Return only catastrophic --write problems that should not be committed."""

    check_markdown = without_fenced_code(markdown)
    headings = parse_headings(check_markdown)
    problems: list[str] = []
    h1 = [item for item in headings if item["level"] == 1]
    if len(h1) != 1:
        problems.append(f"完整报告必须有且只有一个一级标题，当前检测到 {len(h1)} 个。")
    if not has_nonempty_summary(check_markdown):
        problems.append("完整报告缺少非空的摘要/概览章节。")
    if not any(is_conclusion_heading(item["text"]) for item in headings):
        problems.append("完整报告缺少结论/建议章节。")
    if not any(heading_role(item["text"]) == "references" for item in headings):
        if REFERENCE_DEF_RE.search(markdown):
            problems.append(
                "报告已包含 `[^n]:` 参考文献定义，但所在章节标题不是标准参考文献标题；"
                "请将其重命名为 `## 参考文献`（中文报告）或 `## References`（英文报告），"
                "不要新增额外的参考文献章节。"
            )
        else:
            problems.append("完整报告缺少参考文献章节。")

    visible = visible_text_for_language_check(check_markdown)
    dominant = language_from_text(visible)
    if dominant and dominant != language:
        problems.append(
            f"完整报告主体语言为 {LANGUAGE_LABELS[dominant]['name']}，"
            f"但报告语言已确定为 {LANGUAGE_LABELS[language]['name']}。"
        )

    if previous_markdown:
        previous_words = count_effective_words(previous_markdown, Findings())
        incoming_words = count_effective_words(markdown, Findings())
        if previous_words >= 1000 and incoming_words < 100 and incoming_words < previous_words * 0.05:
            problems.append(
                f"本次全文输入仅约 {incoming_words} 字，现有报告约 {previous_words} 字，"
                "疑似诊断或测试文本；不得用正式 --write 入口做测试。"
            )
    return problems


def paragraph_blocks(markdown: str) -> list[dict]:
    """Create a conservative block model; inline Markdown remains in `markdown`."""
    lines = normalize_newlines(markdown).splitlines()
    blocks: list[dict] = []
    paragraph: list[str] = []
    in_code = False
    code_fence = ""
    code_lines: list[str] = []
    code_language = ""

    def flush_paragraph() -> None:
        """Flush the buffered paragraph lines into a paragraph block."""
        if paragraph:
            value = "\n".join(paragraph).strip()
            if value:
                blocks.append({"type": "paragraph", "markdown": value})
            paragraph.clear()

    index = 0
    while index < len(lines):
        line = lines[index]
        if in_code:
            if line.startswith(code_fence):
                blocks.append({"type": "code", "language": code_language, "text": "\n".join(code_lines)})
                in_code = False
                code_fence = ""
                code_lines = []
                code_language = ""
            else:
                code_lines.append(line)
            index += 1
            continue
        if line.startswith("```") or line.startswith("~~~"):
            flush_paragraph()
            in_code = True
            code_fence = line[:3]
            code_language = line[3:].strip()
            index += 1
            continue
        if re.fullmatch(r"\s*\*\*[^*]+\*\*\s*", line) and heading_role(line) == "summary":
            flush_paragraph()
            blocks.append({"type": "paragraph", "markdown": line.strip()})
            index += 1
            continue
        heading = re.match(r"^(#{1,6})\s+(.+?)\s*$", line)
        if heading:
            flush_paragraph()
            text_value = heading.group(2).strip()
            blocks.append({"type": "heading", "level": len(heading.group(1)), "markdown": text_value})
            index += 1
            continue
        image = IMAGE_RE.fullmatch(line.strip())
        if image:
            flush_paragraph()
            raw_path = image.group(2) or image.group(3)
            resolved = resolve_local_image(raw_path)
            blocks.append(
                {
                    "type": "image",
                    "alt": image.group(1).strip(),
                    "title": (image.group(4) or "").strip(),
                    "path": str(resolved) if resolved else raw_path,
                }
            )
            index += 1
            continue
        if index + 1 < len(lines) and "|" in line:
            separator = split_table_row(lines[index + 1])
            if separator and all(re.fullmatch(r":?-{3,}:?", cell) for cell in separator):
                flush_paragraph()
                header = split_table_row(line)
                rows: list[list[str]] = []
                index += 2
                while index < len(lines) and "|" in lines[index] and lines[index].strip():
                    rows.append(split_table_row(lines[index]))
                    index += 1
                blocks.append({"type": "table", "header": header, "rows": rows})
                continue
        list_item = re.match(r"^(\s*)([-*+] |\d+[.)]\s+)(.+)$", line)
        if list_item:
            flush_paragraph()
            marker = list_item.group(2).strip()
            blocks.append(
                {
                    "type": "list_item",
                    "ordered": bool(re.match(r"\d", marker)),
                    "level": len(list_item.group(1).replace("\t", "    ")) // 2,
                    "markdown": list_item.group(3).strip(),
                }
            )
            index += 1
            continue
        if line.lstrip().startswith(">"):
            flush_paragraph()
            blocks.append({"type": "blockquote", "markdown": line.lstrip()[1:].strip()})
            index += 1
            continue
        if REFERENCE_DEF_RE.fullmatch(line):
            flush_paragraph()
            index += 1
            continue
        if not line.strip():
            flush_paragraph()
        else:
            paragraph.append(line)
        index += 1

    flush_paragraph()
    if in_code:
        blocks.append({"type": "code", "language": code_language, "text": "\n".join(code_lines)})
    return blocks


def navigation_blocks(markdown: str) -> tuple[list[dict], list[dict]]:
    """Remove Markdown TOC rows from the render stream and build static navigation."""

    raw_blocks = paragraph_blocks(markdown)
    blocks: list[dict] = []
    in_toc = False
    has_toc = False
    for block in raw_blocks:
        if block.get("type") == "heading":
            level = int(block.get("level") or 2)
            role = heading_role(str(block.get("markdown") or ""))
            if level == 2 and role == "toc":
                has_toc = True
                in_toc = True
                blocks.append(block)
                continue
            if in_toc and level <= 2:
                in_toc = False
        if in_toc and block.get("type") == "list_item":
            continue
        if in_toc:
            # The generated entries are the leading list only.  Content after
            # that list (for example an abbreviation table) remains renderable.
            in_toc = False
        blocks.append(block)

    content_headings: list[dict] = []
    current_main_included = False
    bookmark_number = 0
    for block in blocks:
        if block.get("type") != "heading":
            continue
        level = int(block.get("level") or 2)
        role = heading_role(str(block.get("markdown") or ""))
        if level == 2:
            current_main_included = role not in {"summary", "toc"}
        if level >= 2 and role not in {"summary", "toc"}:
            bookmark_number += 1
            block["bookmark"] = f"section_{bookmark_number}"
        if level == 2 and current_main_included:
            content_headings.append(block)
        elif level == 3 and current_main_included:
            content_headings.append(block)

    selected = content_headings
    if len(selected) > TOC_MAX_ITEMS_WITH_SUBSECTIONS:
        selected = [item for item in selected if int(item.get("level") or 2) == 2]
    toc = [
        {
            "level": 2 if int(item.get("level") or 2) == 3 else 1,
            "text": strip_inline_markup(str(item.get("markdown") or "")).strip(),
            "bookmark": item["bookmark"],
        }
        for item in selected
    ] if has_toc else []
    return blocks, toc


def build_render_model(markdown: str, digest: str, details: dict, language: str) -> dict:
    """Assemble the JSON render model consumed by report_renderer.js."""
    title = next(
        (item["text"] for item in details["headings"] if item["level"] == 1),
        LANGUAGE_LABELS[language]["fallback_title"],
    )
    blocks, toc = navigation_blocks(markdown)
    return {
        "schema_version": 1,
        "source": {
            "path": str(REPORT_MD),
            "sha256": digest,
            "effective_words": details["effective_words"],
        },
        "document": {
            "title": title,
            "language": language,
            "blocks": blocks,
            "toc": toc,
            "references": details["references"],
            "images": details["images"],
        },
    }


def invalidate_stale_docx(state: dict, render_key: str) -> None:
    """Move a docx built from stale content aside and mark render status stale."""
    if not REPORT_DOCX.exists() or state.get("rendered_hash") == render_key:
        return
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    cached = CACHE_DIR / "last_good.docx"
    os.replace(REPORT_DOCX, cached)
    state["render_status"] = "stale"


def backup_before_full_rewrite(new_digest: str, state: dict) -> None:
    """Keep one rolling internal recovery copy before a changed --write."""
    if not REPORT_MD.is_file():
        return
    previous = REPORT_MD.read_text(encoding="utf-8")
    previous_digest = content_hash(previous)
    if previous_digest == new_digest:
        return
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    atomic_write_text(CACHE_DIR / "previous_report.md", previous)
    state["previous_markdown_hash"] = previous_digest


def check_full_write_budget(new_digest: str, state: dict) -> tuple[bool, int]:
    """Return (content_changed, prior_usage), rejecting a third changed --write."""
    used = max(0, int(state.get("full_writes_used") or 0))
    existing_digest: str | None = None
    if REPORT_MD.is_file():
        existing_digest = content_hash(REPORT_MD.read_text(encoding="utf-8"))
        # Migrate reports created by an older save_report version.
        used = max(used, 1)
    if (CACHE_DIR / "previous_report.md").is_file():
        # This rolling backup is created only by a changed full rewrite.
        used = max(used, 2)
    state["full_writes_used"] = used

    changed = existing_digest != new_digest
    if changed and used >= DEFAULT_MAX_FULL_WRITES:
        raise ReportError(
            f"完整写入次数已达上限 {DEFAULT_MAX_FULL_WRITES} 次；"
            "请使用 --patch 增量增加、修正或替换章节。"
        )
    return changed, used


def run_renderer(model: dict, digest: str) -> tuple[bool, list[str]]:
    """Invoke the Node.js DOCX renderer on the render model and validate its output."""
    errors: list[str] = []
    if not RENDERER.is_file():
        return False, [f"缺少内部渲染器：{RENDERER}"]
    node = os.environ.get("NODE_EXECUTABLE") or shutil.which("node")
    if not node:
        return False, ["未找到 Node.js，无法运行内部 DOCX 渲染器。"]

    BUILD_DIR.mkdir(parents=True, exist_ok=True)
    REPORTS_DIR.mkdir(parents=True, exist_ok=True)
    model_path = BUILD_DIR / "render_model.json"
    atomic_write_json(model_path, model)
    fd, raw_output = tempfile.mkstemp(prefix=".report.", suffix=".docx", dir=REPORTS_DIR)
    os.close(fd)
    output = Path(raw_output)
    output.unlink(missing_ok=True)

    try:
        completed = subprocess.run(
            [node, str(RENDERER), "--input", str(model_path), "--output", str(output)],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=RENDER_TIMEOUT_SECONDS,
            check=False,
        )
    except subprocess.TimeoutExpired:
        output.unlink(missing_ok=True)
        return False, [f"内部渲染超过 {RENDER_TIMEOUT_SECONDS} 秒，已终止。"]
    except OSError as exc:
        output.unlink(missing_ok=True)
        return False, [f"无法启动内部渲染器：{exc}"]

    if completed.returncode != 0:
        output.unlink(missing_ok=True)
        detail = (completed.stderr or completed.stdout or "无详细输出").strip()
        return False, [f"内部渲染器退出码 {completed.returncode}：{detail}"]

    errors.extend(validate_docx(output, model))
    if errors:
        output.unlink(missing_ok=True)
        return False, errors
    os.replace(output, REPORT_DOCX)
    return True, []


def validate_docx(path: Path, model: dict) -> list[str]:
    """Verify the rendered DOCX contains the expected title, headings, images and links."""
    errors: list[str] = []
    if not path.is_file() or path.stat().st_size == 0:
        return ["渲染器未生成非空 DOCX。"]
    required_parts = {"[Content_Types].xml", "word/document.xml"}
    try:
        with zipfile.ZipFile(path) as archive:
            names = set(archive.namelist())
            missing = required_parts - names
            if missing:
                errors.append("DOCX 缺少必要 OOXML 部件：" + "、".join(sorted(missing)))
                return errors
            document_xml = archive.read("word/document.xml")
            try:
                root = ET.fromstring(document_xml)
                visible_text = "".join(root.itertext())
            except ET.ParseError as exc:
                errors.append(f"word/document.xml 无法解析：{exc}")
                return errors

            title = model["document"]["title"]
            if strip_inline_markup(title) not in visible_text:
                errors.append("DOCX 中缺少报告标题。")
            for block in model["document"]["blocks"]:
                if block.get("type") == "heading":
                    heading = strip_inline_markup(block.get("markdown", "")).strip()
                    if heading and heading not in visible_text:
                        errors.append(f"DOCX 中缺少章节标题：{heading}")
            if re.search(r"\[\^[^\]]+\]", visible_text):
                errors.append("DOCX 可见文本中残留原始引用标记。")

            expected_images = len(model["document"].get("images", []))
            actual_images = sum(1 for name in names if name.startswith("word/media/") and not name.endswith("/"))
            if actual_images < expected_images:
                errors.append(f"DOCX 图片数量不足：预期至少 {expected_images}，实际 {actual_images}。")

            reference_urls = {
                normalize_url(url)
                for reference in model["document"].get("references", [])
                for url in reference.get("urls", [])
            }
            if reference_urls:
                rels_name = "word/_rels/document.xml.rels"
                if rels_name not in names:
                    errors.append("DOCX 缺少外部超链接关系。")
                else:
                    try:
                        rels_root = ET.fromstring(archive.read(rels_name))
                        external_urls = {
                            normalize_url(str(item.attrib.get("Target", "")))
                            for item in rels_root
                            if item.attrib.get("TargetMode") == "External"
                            and str(item.attrib.get("Target", "")).startswith(("http://", "https://"))
                        }
                    except ET.ParseError as exc:
                        errors.append(f"DOCX 超链接关系无法解析：{exc}")
                        external_urls = set()
                    for url in reference_urls:
                        if url not in external_urls:
                            errors.append(f"DOCX 中缺少可点击的参考文献链接：{url}")

            toc = model["document"].get("toc", [])
            if toc:
                word_ns = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
                bookmarks = {
                    item.attrib.get(word_ns + "name")
                    for item in root.iter(word_ns + "bookmarkStart")
                }
                anchors = {
                    item.attrib.get(word_ns + "anchor")
                    for item in root.iter(word_ns + "hyperlink")
                }
                expected = {item["bookmark"] for item in toc}
                missing_bookmarks = sorted(expected - bookmarks)
                missing_links = sorted(expected - anchors)
                if missing_bookmarks:
                    errors.append("DOCX 目录目标书签缺失：" + "、".join(missing_bookmarks))
                if missing_links:
                    errors.append("DOCX 目录内部链接缺失：" + "、".join(missing_links))
                if re.search(r"\[[^\]]+\]\(#[^)]+\)", visible_text):
                    errors.append("DOCX 目录中残留 Markdown 锚点语法。")
    except (OSError, zipfile.BadZipFile) as exc:
        errors.append(f"输出不是有效 DOCX/ZIP：{exc}")
    return errors


def print_findings(findings: Findings) -> None:
    """Print blocking errors and warnings to stderr."""
    if findings.errors:
        print(f"阻塞问题（{len(findings.errors)}）：", file=sys.stderr)
        for index, message in enumerate(findings.errors, 1):
            print(f"  {index}. {message}", file=sys.stderr)
    if findings.warnings:
        print(f"警告（{len(findings.warnings)}）：", file=sys.stderr)
        for index, message in enumerate(findings.warnings, 1):
            print(f"  {index}. {message}", file=sys.stderr)


def handle_word_gate(
    effective_words: int,
    digest: str,
    state: dict,
) -> tuple[str, str | None]:
    """Decide pass/remind/pending/soft_pass for the word-count gate and update reminder counts."""
    explicit = state.get("explicit_min_words")

    # Explicit user minimum: hard gate — re-checked every call, no permanent release.
    if explicit is not None:
        if effective_words >= explicit:
            return "pass", None
        used = int(state.get("word_reminders_used") or 0)
        maximum = int(state.get("word_reminders_max") or DEFAULT_MAX_WORD_REMINDERS)
        last_hash = state.get("last_word_reminder_hash")
        if used < maximum and digest != last_hash:
            used += 1
            state["word_reminders_used"] = used
            state["last_word_reminder_hash"] = digest
            return (
                "remind",
                f"当前有效正文约 {effective_words} 字，用户要求至少 {explicit} 字；"
                f"这是第 {used}/{maximum} 次字数提醒。只可展开已有结论，不得新增事实、数据、案例或来源。",
            )
        if used < maximum:
            return (
                "pending",
                f"当前有效正文仍为约 {effective_words}/{explicit} 字；相同内容已提醒过，"
                f"提醒计数保持 {used}/{maximum}。",
            )
        # Reminders exhausted for explicit minimum: still block (no soft_pass).
        return (
            "explicit_block",
            f"当前有效正文约 {effective_words} 字，用户要求至少 {explicit} 字，字数提醒已达上限 {maximum} 次；"
            "必须继续补充已有内容，直到满足用户明确要求的最低字数后方可渲染。"
            "只可展开已有结论，不得新增无依据的事实、数据、案例或来源。",
        )

    # Default advisory (6000–10000 words): purely advisory — never blocks.
    return "pass", None


# ---------------------------------------------------------------------------
# Semantic review checklist items (Fix C)
# ---------------------------------------------------------------------------

_FINALIZE_ITEMS = [
    "用户原始问题是否得到实质回答，而不只是存在对应章节",
    "反思中的修正是否已应用，被修正的旧表述是否已经删除",
    "是否出现任务结论和反思中不存在的新事实、数字、日期、排名、版本、案例或来源",
    "关键事实和数字的引用是否真正支持相邻论述，而不只是引用格式正确",
    "表格和图表的数据是否同口径、可比并与任务结论一致；派生数字是否经过计算复核；"
    "摘要、正文和结论是否存在语义矛盾或无意义重复",
]

_FINALIZE_EXAMPLE = (
    "SEMANTIC_REVIEW_RESULT:\n"
    "1. PASS\n"
    "2. PASS\n"
    "3. PASS\n"
    "4. PASS\n"
    "5. PASS\n"
)

# Schema shown in REPORT_READY_FOR_SEMANTIC_REVIEW — uses placeholders, not pre-filled answers.
_FINALIZE_SCHEMA = (
    "SEMANTIC_REVIEW_RESULT:\n"
    "1. <PASS|NEEDS_FIX>\n"
    "2. <PASS|NEEDS_FIX>\n"
    "3. <PASS|NEEDS_FIX>\n"
    "4. <PASS|NEEDS_FIX>\n"
    "5. <PASS|NEEDS_FIX>\n"
)


def _handle_finalize() -> int:
    """Process save_report.py --finalize: read semantic attestation from stdin."""
    try:
        state = load_state()
    except StateIntegrityError as exc:
        print(f"REPORT_INTEGRITY_ERROR: {exc}", file=sys.stderr)
        print("FINALIZED: no", file=sys.stderr)
        return EXIT_INPUT_ERROR

    # §四: frozen report inputs must not change even at finalize (detect-and-stop).
    _finalize_source_changes = changed_source_artifacts(state.get("source_snapshot"))
    if state.get("report_inputs_frozen") and _finalize_source_changes:
        print("REPORT_INPUT_CHANGED", file=sys.stderr)
        print("FINALIZED: no", file=sys.stderr)
        for change in _finalize_source_changes:
            print(f"  {change}", file=sys.stderr)
        print(
            "ERROR: 报告输入已在 Stage6 冻结，但来源素材（任务结论 / 反思）发生变化；"
            "不能对与冻结来源不一致的内容确认交付。",
            file=sys.stderr,
        )
        print(
            "NEXT: 请将 conclusions/ 与 reflection/ 下的来源文件恢复为冻结时的内容后重试；"
            "脚本不会重新冻结快照或扩大来源白名单。",
            file=sys.stderr,
        )
        print("INTERACTION_RULE: NO_ASK_USER", file=sys.stderr)
        return EXIT_INPUT_ERROR

    # C-E: Idempotency — if already finalized with unchanged markdown, return terminal state.
    # Disk freshness MUST be verified before any early return — an out-of-band edit after
    # a successful finalize must still be rejected on the next --finalize call.
    try:
        _idem_render_key = render_fingerprint(
            str(state.get("markdown_hash") or ""),
            str(state.get("report_language") or "zh-CN"),
        )
    except Exception:
        _idem_render_key = None
    if (
        state.get("semantic_review_status") == "passed"
        and state.get("semantic_review_hash") == state.get("markdown_hash")
        and _idem_render_key is not None
        and state.get("rendered_hash") == _idem_render_key
        and REPORT_DOCX.is_file()
    ):
        # Verify disk report.md is still consistent before declaring idempotent success.
        if REPORT_MD.is_file():
            _idem_disk_digest = content_hash(REPORT_MD.read_text(encoding="utf-8"))
            if _idem_disk_digest != state.get("markdown_hash"):
                print(
                    "FINALIZE_REJECTED: 正式 report.md 在脚本外被修改（idempotent 检查），"
                    "无法对已变更内容进行语义审查确认。"
                    "请使用 --write 或 --patch 重新保存后再执行 --finalize。",
                    file=sys.stderr,
                )
                print("FINALIZED: no", file=sys.stderr)
                return EXIT_INPUT_ERROR
        else:
            print("FINALIZE_REJECTED: 正式 report.md 不存在。", file=sys.stderr)
            print("FINALIZED: no", file=sys.stderr)
            return EXIT_INPUT_ERROR
        print("FINALIZED: yes (idempotent — no changes since last finalize)")
        print("WORKFLOW_STATE: REPORT_READY_TO_DELIVER")
        print("FINAL_REPORT_READY: yes")
        print("MECHANICAL_CHECKS: passed")
        print("SEMANTIC_REVIEW: passed")
        print("REPORT_EDIT_GUARD: STOP_EDITING")
        print("FORBIDDEN: --write | --patch | optional_polish | shadow_report_draft | "
              "baidu_search.py | fetch_webpage.py | ask_user")
        print("DELIVERY_BLOCK:")
        print("```files")
        print(str(REPORT_DOCX))
        print("```")
        return EXIT_OK

    # Require report to be in rendered state.
    if state.get("render_status") not in ("rendered",):
        print(
            "FINALIZE_REJECTED: 报告尚未通过机械校验并成功渲染，无法进行语义审查。"
            "请先完成 save_report.py --write 或 --patch 使 render_status=rendered。",
            file=sys.stderr,
        )
        print("FINALIZED: no", file=sys.stderr)
        _print_action_guard(
            "PATCH_ONLY",
            "save_report.py --patch",
            forbidden_extra=["ask_user", "direct_report_edit", "--finalize"],
        )
        return EXIT_INPUT_ERROR

    # Verify current rendered_hash is consistent with current markdown_hash + language.
    try:
        language = detect_report_language()
    except Exception:
        language = state.get("report_language") or "zh-CN"
    expected_render_key = render_fingerprint(str(state.get("markdown_hash") or ""), language)
    if state.get("rendered_hash") != expected_render_key or not REPORT_DOCX.is_file():
        print(
            "FINALIZE_REJECTED: 报告已修改但尚未重新渲染（rendered_hash 与当前 markdown_hash 不一致）。"
            "请先使用 --write 或 --patch 重新保存并等待渲染完成。",
            file=sys.stderr,
        )
        print("FINALIZED: no", file=sys.stderr)
        retry_mode = "--patch"
        _print_action_guard(
            "PATCH_ONLY",
            f"save_report.py {retry_mode}",
            forbidden_extra=["ask_user", "direct_report_edit", "--finalize"],
        )
        return EXIT_INPUT_ERROR

    # C-A: Verify disk report.md has not been modified out-of-band since last save.
    if REPORT_MD.is_file():
        disk_digest = content_hash(REPORT_MD.read_text(encoding="utf-8"))
        if disk_digest != state.get("markdown_hash"):
            print(
                "FINALIZE_REJECTED: 正式 report.md 在脚本外被修改，"
                "无法对已变更内容进行语义审查确认。"
                "请使用 --write 或 --patch 重新保存后再执行 --finalize。",
                file=sys.stderr,
            )
            print("FINALIZED: no", file=sys.stderr)
            return EXIT_INPUT_ERROR
    else:
        print("FINALIZE_REJECTED: 正式 report.md 不存在。", file=sys.stderr)
        print("FINALIZED: no", file=sys.stderr)
        return EXIT_INPUT_ERROR

    # Read attestation from stdin.
    try:
        attestation_raw = read_stdin()
    except ReportError as exc:
        print(f"INPUT_ERROR: {exc}", file=sys.stderr)
        print("FINALIZED: no", file=sys.stderr)
        print("FINALIZE_FORMAT:", file=sys.stderr)
        print(_FINALIZE_EXAMPLE, file=sys.stderr)
        print(
            "NEXT: 使用 SEMANTIC_REVIEW_RESULT 格式提交语义审查结果，所有条目必须为 PASS。",
            file=sys.stderr,
        )
        return EXIT_INPUT_ERROR

    # Parse attestation: expect "SEMANTIC_REVIEW_RESULT:\n1. PASS\n2. PASS\n..."
    items_result = _parse_finalize_attestation(attestation_raw)
    if items_result is None:
        print(
            "FINALIZE_REJECTED: stdin 未包含有效的 SEMANTIC_REVIEW_RESULT 格式。",
            file=sys.stderr,
        )
        print("FINALIZED: no", file=sys.stderr)
        print("FINALIZE_FORMAT:", file=sys.stderr)
        print(_FINALIZE_EXAMPLE, file=sys.stderr)
        print(
            "NEXT: 使用上述格式，对全部 5 条必检项给出 PASS 或 NEEDS_FIX 结论后重新提交。",
            file=sys.stderr,
        )
        return EXIT_INPUT_ERROR

    n_required = len(_FINALIZE_ITEMS)
    needs_fix = [i for i, verdict in items_result.items() if verdict != "PASS"]
    missing = [i for i in range(1, n_required + 1) if i not in items_result]

    if missing or needs_fix:
        print("FINALIZE_REJECTED: 语义审查未完全通过。", file=sys.stderr)
        if missing:
            print(f"  缺少必检项: {', '.join(str(i) for i in sorted(missing))}", file=sys.stderr)
        if needs_fix:
            print(f"  仍需修正: {', '.join(str(i) for i in sorted(needs_fix))}", file=sys.stderr)
        print("FINALIZED: no", file=sys.stderr)
        print(
            "NEXT: 修正上述语义问题（使用 save_report.py --patch）后，"
            "重新执行阶段 6.5 语义检查，再次提交 --finalize。",
            file=sys.stderr,
        )
        _print_action_guard(
            "PATCH_ONLY",
            "save_report.py --patch",
            forbidden_extra=["ask_user", "direct_report_edit", "--finalize"],
        )
        return EXIT_NEEDS_REVISION

    # All PASS — record finalize state and emit terminal delivery block.
    state["semantic_review_status"] = "passed"
    # C-B: semantic_review_hash must equal current markdown_hash (not rendered_hash).
    state["semantic_review_hash"] = state.get("markdown_hash")
    try:
        save_state(state)
    except OSError as exc:
        print(
            f"ENVIRONMENT_ERROR: 无法保存语义审查状态：{exc}",
            file=sys.stderr,
        )
        return EXIT_RENDER_ERROR

    print("FINALIZED: yes")
    print("WORKFLOW_STATE: REPORT_READY_TO_DELIVER")
    # C-D: terminal signal block.
    print("FINAL_REPORT_READY: yes")
    print("MECHANICAL_CHECKS: passed")
    print("SEMANTIC_REVIEW: passed")
    print("REPORT_EDIT_GUARD: STOP_EDITING")
    print("FORBIDDEN: --write | --patch | optional_polish | shadow_report_draft | "
          "baidu_search.py | fetch_webpage.py | ask_user")
    review_scope = str(state.get("semantic_review_scope") or "full")
    print(f"REVIEW_SCOPE: {review_scope}")
    print(f"RENDERED_FILE: {REPORT_DOCX}")
    print("DELIVERY_BLOCK:")
    print("```files")
    print(str(REPORT_DOCX))
    print("```")
    print(
        "NEXT: 阶段 6.6 — 先看 outputs/用户原始问题.md 的输出形式，"
        "按请求格式生成并交付报告；"
        "默认/Word 请求在最终回答原样包含上述 files 块；"
        "其他格式先按阶段 6.6 转换，再用 files 块登记对应交付文件。"
    )
    return EXIT_OK


def _parse_finalize_attestation(text: str) -> "dict[int, str] | None":
    """Parse SEMANTIC_REVIEW_RESULT block from attestation text.

    Accepts both:
      SEMANTIC_REVIEW_RESULT:
      1. PASS
      ...
    and inline verdicts like "1. PASS 2. NEEDS_FIX ...".
    Returns {item_number: verdict_string} or None if format is unrecognisable.
    """
    if "SEMANTIC_REVIEW_RESULT" not in text:
        return None
    result: dict[int, str] = {}
    item_re = re.compile(r"\b(\d+)\s*[.)]\s+(PASS|NEEDS_FIX)\b", re.IGNORECASE)
    for m in item_re.finditer(text):
        idx = int(m.group(1))
        verdict = m.group(2).upper()
        if 1 <= idx <= len(_FINALIZE_ITEMS):
            result[idx] = verdict
    return result if result else None


def print_delivery_next(
    length_gate_released: bool = False,
    length_gate_just_released: bool = False,
    review_scope: str = "full",
) -> None:
    """Signal REPORT_READY_FOR_SEMANTIC_REVIEW.

    The agent must now perform Stage 6.5 semantic review before calling --finalize.
    Pre-filled PASS answers are intentionally NOT shown here to avoid the agent
    mistaking the schema for a completed review.
    """

    print("WORKFLOW_STATE: REPORT_READY_FOR_SEMANTIC_REVIEW")
    print("REPORT_EDIT_GUARD: NO_EDIT_BEFORE_REVIEW")
    if length_gate_just_released:
        print("LENGTH_GATE_RELEASED: yes")
        print("LENGTH_STATUS: accepted（不得再为该 explicit minimum 增补）")
    elif length_gate_released:
        print("LENGTH_STATUS: already_accepted")
    print("MECHANICAL_CHECKS: passed")
    print("SEMANTIC_REVIEW: required")
    print(f"REVIEW_SCOPE: {review_scope}")
    print(f"RENDERED_FILE: {REPORT_DOCX}")
    print("NEXT_ACTION: PERFORM_SEMANTIC_REVIEW")
    print("SEMANTIC_REVIEW_REQUIRED_BEFORE_FINALIZE: true")
    print("DO_NOT_CALL_FINALIZE_YET: true")
    if review_scope == "targeted":
        review_next = (
            "仅复核本次修改段落、相邻论述以及受影响的摘要、结论和交叉引用；"
            "不要重新开始全文语义检查。"
        )
    else:
        review_next = (
            "完整执行一次阶段 6.5 语义检查并先汇总全部问题；"
            "需要局部修改时尽量在一次 --patch 中一并处理。"
        )
    length_next = "篇幅已通过，后续只处理明确的语义问题；" if length_gate_released else ""
    print(
        f"NEXT: {length_next}{review_next}"
        "全部现有必检项 PASS 后，使用 save_report.py --finalize 提交语义审查结果；"
        "交付文件路径将在 --finalize 成功后返回。"
        "如需整体重写，仅当语义检查确认全局方向/结构问题且 FULL_WRITES_USED < 2 时才使用 --write；否则用 --patch。"
    )
    print("FINALIZE_TOOL_AFTER_REVIEW: save_report.py --finalize")
    print("FINALIZE_INPUT_SCHEMA:")
    print(_FINALIZE_SCHEMA)
    print(
        "FINALIZE_RULE: 全部 5 条必须是 PASS；如有 NEEDS_FIX 条目，先用 --patch 修正后重新执行语义检查再 --finalize；"
        "以上 heredoc 格式必须完整传入 stdin，不得用 echo 或省略行。"
    )
    emit_patch_contract(sys.stdout)


def main() -> int:
    """CLI entry point: parse args and dispatch to write/patch/finalize handling."""
    parser = argparse.ArgumentParser(
        description="Save/patch the canonical Markdown report, validate it, and render when ready.",
        epilog="Report or patch content is read from stdin; output paths are inferred automatically.",
    )
    modes = parser.add_mutually_exclusive_group(required=True)
    modes.add_argument("--write", action="store_true", help="首次完整写入或全文替换 report.md")
    modes.add_argument(
        "--patch",
        action="store_true",
        help="基于同一原始快照原子应用一个或多个精确 REPLACE 修改",
    )
    modes.add_argument(
        "--finalize",
        action="store_true",
        help="提交语义审查结果（5 条必检项均 PASS），核实渲染无变化后解锁交付文件",
    )
    parser.add_argument(
        "--min-words",
        type=int,
        default=None,
        help="用户原始问题中明确指定的整体报告最低字数（hard requirement，未达到时阻止渲染，不因调用次数放行）",
    )
    parser.add_argument(
        "--output-dir",
        default=None,
        help="已废弃，保留仅为兼容旧调用；save_report.py 通过脚本位置自动推断项目根，此参数被忽略。",
    )
    args = parser.parse_args()

    if getattr(args, "output_dir", None) is not None:
        print(
            "WARNING: --output-dir 已废弃；save_report.py 从脚本位置自动推断项目根，"
            "此参数被忽略。",
            file=sys.stderr,
        )

    configure_runtime_paths()

    # --finalize: structured semantic review attestation, no stdin report content needed.
    if args.finalize:
        return _handle_finalize()

    if args.min_words is not None and not 1 <= args.min_words <= MAX_EXPLICIT_MIN_WORDS:
        print(
            f"INPUT_ERROR: --min-words 必须在 1 到 {MAX_EXPLICIT_MIN_WORDS} 之间。",
            file=sys.stderr,
        )
        return EXIT_INPUT_ERROR

    # §四: a frozen-source change (including a deleted source) must surface as
    # REPORT_INPUT_CHANGED, taking precedence over the generic prerequisite error —
    # otherwise deleting a frozen conclusion would look like a missing prerequisite.
    try:
        _early_state = load_state()
    except Exception:
        _early_state = None
    if isinstance(_early_state, dict) and _early_state.get("report_inputs_frozen"):
        _early_changes = changed_source_artifacts(_early_state.get("source_snapshot"))
        if _early_changes:
            return emit_report_input_changed(_early_changes)

    prerequisites = ensure_prerequisites()
    if prerequisites:
        print("REPORT_PREREQUISITE_ERROR", file=sys.stderr)
        for index, problem in enumerate(prerequisites, 1):
            print(f"  {index}. {problem}", file=sys.stderr)
        print("SAVED: no", file=sys.stderr)
        retry_mode = "--write" if args.write else "--patch"
        print(
            f"NEXT: 补齐上述前置文件后，重新使用 save_report.py {retry_mode}。",
            file=sys.stderr,
        )
        return EXIT_INPUT_ERROR

    try:
        incoming = read_stdin()
        state = load_state()
        language = detect_report_language()
        locked_language = state.get("report_language")
        if locked_language and locked_language != language:
            raise StateIntegrityError(
                "报告语言依据在首次成文后发生变化，不能在后续写入中切换报告语言。"
            )
        predecessor_rendered = bool(state.get("rendered_hash")) and (
            state.get("rendered_hash")
            == render_fingerprint(
                str(state.get("markdown_hash") or ""),
                language,
            )
        )
        integrity = enforce_report_integrity(state)
        if integrity is not None:
            print("REPORT_INTEGRITY_ERROR", file=sys.stderr)
            if integrity["was_missing"]:
                print("  正式 report.md 在脚本外被删除。", file=sys.stderr)
            else:
                print("  正式 report.md 在脚本外发生变化；本次输入未应用。", file=sys.stderr)
            if integrity["backup"] is not None:
                print("OUT_OF_BAND_BACKUP: saved", file=sys.stderr)
            if integrity["restored_from"] is not None:
                print(f"RESTORED: yes ({REPORT_MD})", file=sys.stderr)
                _print_action_guard(
                    "PATCH_RETRY_ONLY",
                    "save_report.py --patch",
                    forbidden_extra=["ask_user", "direct_report_edit", "--write"],
                )
                print(
                    "NEXT: 重新读取已恢复的 reports/report.md，从当前恢复版本精确复制 OLD_STR，重新构造 --patch。",
                    file=sys.stderr,
                )
            else:
                print("RESTORED: no（缺少与状态哈希一致的内部恢复副本）", file=sys.stderr)
                print(
                    "NEXT: 停止修改，不得读取或改写内部状态与缓存，也不得绕过 save_report.py；"
                    "保留现有文件供人工恢复。",
                    file=sys.stderr,
                )
            print("SAVED: no", file=sys.stderr)
            return EXIT_INPUT_ERROR
        patch_details: list[dict[str, int]] = []
        if args.write:
            first_nonempty = next((line.strip() for line in incoming.splitlines() if line.strip()), "")
            marker = PATCH_MARKER_RE.fullmatch(first_nonempty)
            if marker:
                raise ReportError(
                    "检测到补丁操作标记，但当前使用了 --write；为避免补丁文本覆盖全文，请改用 --patch。"
                )
            markdown = incoming.rstrip() + "\n"
        else:
            if not REPORT_MD.is_file():
                raise InitialReportMissingError("正式 report.md 不存在，首次写入必须使用 --write。")
            original = REPORT_MD.read_text(encoding="utf-8")
            try:
                operations = parse_patch(incoming)
            except PatchError as exc:
                raise PatchFormatError(str(exc)) from exc
            markdown, patch_details = apply_patch_with_details(original, operations)
        markdown, toc_meta = canonicalize_toc(markdown, language)
        markdown, _syntax_normalized = normalize_citation_syntax(markdown)
        if not isinstance(state.get("source_snapshot"), dict):
            state["source_snapshot"] = capture_source_snapshot()
        frozen_urls = source_snapshot_allowed_urls(state["source_snapshot"])
        frozen_sources = source_snapshot_entries(state["source_snapshot"], frozen_urls)
        source_changes = changed_source_artifacts(state["source_snapshot"])
        if state.get("report_inputs_frozen") and source_changes:
            return emit_report_input_changed(source_changes)
        # P0-2: already-frozen state whose source handoff is unusable (empty
        # allowlist while the report needs web citations) cannot be repaired in
        # the Report Stage — emit a distinct handoff error, not [GLOBAL]/actions.
        if (
            state.get("report_inputs_frozen")
            and not frozen_urls
            and REFERENCE_DEF_RE.search(markdown)
        ):
            return emit_report_source_handoff_error()
        _precheck_errors = _citation_precheck(markdown, frozen_urls)
        _was_renumbered = False
        if not _precheck_errors:
            markdown, _was_renumbered = renumber_citations(markdown)
        if args.write:
            previous_markdown = (
                REPORT_MD.read_text(encoding="utf-8") if REPORT_MD.is_file() else None
            )
            preflight = write_preflight_problems(markdown, language, previous_markdown)
            # §五: only the anti-abuse check discards the draft (guards against
            # overwriting a long report with diagnostic/test stub text). Structural
            # problems no longer throw away the whole draft — the report is saved and
            # validate_report surfaces every deterministic issue in one return, so a
            # single mechanical miss never wastes the agent's full report text.
            abuse_problems = [p for p in preflight if "疑似诊断或测试文本" in p]
            if abuse_problems:
                raise WritePreflightError(
                    "全文写入预检未通过：\n"
                    + "\n".join(
                        f"  {index}. {problem}"
                        for index, problem in enumerate(abuse_problems, 1)
                    )
                )
    except (ReportError, OSError) as exc:
        if isinstance(exc, StateIntegrityError):
            print(f"REPORT_INTEGRITY_ERROR: {exc}", file=sys.stderr)
            print("SAVED: no", file=sys.stderr)
            print(
                "NEXT: 不得读取、修改或删除内部报告状态和缓存，也不得绕过 "
                "save_report.py；内部副本无法自动恢复时停止报告修改。",
                file=sys.stderr,
            )
            return EXIT_INPUT_ERROR
        if isinstance(exc, WritePreflightError):
            print(f"WRITE_PREFLIGHT_REJECTED: {exc}", file=sys.stderr)
            print("SAVED: no", file=sys.stderr)
            print("REPORT_STATUS: UNCHANGED", file=sys.stderr)
            print(
                f"FULL_WRITES_USED: {int(state.get('full_writes_used') or 0)}/"
                f"{DEFAULT_MAX_FULL_WRITES}",
                file=sys.stderr,
            )
            _print_action_guard(
                "WRITE_RETRY_ONLY",
                "save_report.py --write",
                forbidden_extra=["ask_user", "direct_report_edit", "docx_skill"],
                full_write_consumed="no",
            )
            print(
                "NEXT: 修正完整报告后重新使用 save_report.py --write；本次不消耗 full-write 次数。",
                file=sys.stderr,
            )
        elif isinstance(exc, InitialReportMissingError):
            print(f"PATCH_REJECTED: {exc}", file=sys.stderr)
            print("SAVED: no", file=sys.stderr)
            print("REPORT_STATUS: NOT_CREATED", file=sys.stderr)
            _print_action_guard(
                "INITIAL_WRITE_REQUIRED",
                "save_report.py --write",
                forbidden_extra=["ask_user", "direct_report_edit", "--patch"],
            )
            print(
                "NEXT: 使用完整 Markdown 执行首次 save_report.py --write。",
                file=sys.stderr,
            )
        elif isinstance(exc, PatchTooLargeError):
            # §七: coverage ≥80% — Code directs the next action because the hard rule
            # (patch is局部-only) leaves the choice determined by the full-write budget.
            fw_used = int(state.get("full_writes_used") or 0)
            fw_available = fw_used < DEFAULT_MAX_FULL_WRITES
            print("PATCH_REJECTED: PATCH_TOO_LARGE", file=sys.stderr)
            print(f"  {exc}", file=sys.stderr)
            print("SAVED: no", file=sys.stderr)
            print("REPORT_STATUS: UNCHANGED", file=sys.stderr)
            print(f"PATCH_COVERAGE: {exc.coverage_ratio:.0%}", file=sys.stderr)
            print(f"FULL_WRITE_USED: {fw_used}/{DEFAULT_MAX_FULL_WRITES}", file=sys.stderr)
            print(f"FULL_WRITE_AVAILABLE: {'yes' if fw_available else 'no'}", file=sys.stderr)
            if fw_available:
                # A whole rewrite is the sanctioned path — do NOT forbid --write here.
                _print_action_guard(
                    "FULL_WRITE_REQUIRED",
                    "save_report.py --write",
                    forbidden_extra=["ask_user", "direct_report_edit"],
                )
                print(
                    "NEXT: 覆盖范围已达整体重写量级，使用完整 Markdown 执行 save_report.py --write；"
                    "不要把一次大补丁拆成多个小补丁来绕过 80% 上限。",
                    file=sys.stderr,
                )
            else:
                # No full-write left — a --write of changed content would be rejected,
                # so narrowing the patch is the only viable path.
                _print_action_guard(
                    "PATCH_RETRY_ONLY",
                    "save_report.py --patch",
                    forbidden_extra=["ask_user", "direct_report_edit", "--write"],
                )
                print(
                    "NEXT: full-write 次数已用尽，无法整体重写；请缩小本次 --patch 的 OLD_STR 范围，"
                    "只修订确需变更的段落，分次提交仍须各自低于 80% 覆盖。",
                    file=sys.stderr,
                )
        elif args.patch:
            print(f"PATCH_REJECTED: {exc}", file=sys.stderr)
            print("SAVED: no", file=sys.stderr)
            print("REPORT_STATUS: UNCHANGED", file=sys.stderr)
            _print_action_guard(
                "PATCH_RETRY_ONLY",
                "save_report.py --patch",
                forbidden_extra=["ask_user", "direct_report_edit", "--write"],
            )
            if isinstance(exc, PatchFormatError) or "stdin 内容为空" in str(exc):
                print(
                    "NEXT: 按上述 PATCH_FORMAT 重新提交；OLD_STR 从当前 report.md 原样复制。"
                    "无需读取 save_report.py 源码。",
                    file=sys.stderr,
                )
            else:
                print(
                    "NEXT: 1. 重新读取当前 reports/report.md  "
                    "2. 从当前版本精确复制 OLD_STR  "
                    "3. 重新构造 --patch",
                    file=sys.stderr,
                )
        else:
            # Generic --write error: distinguish mode-mismatch from retryable input errors.
            print(f"INPUT_ERROR: {exc}", file=sys.stderr)
            print("SAVED: no", file=sys.stderr)
            print("REPORT_STATUS: UNCHANGED", file=sys.stderr)
            # Patch marker accidentally submitted via --write → must switch to --patch
            if "补丁操作标记" in str(exc) and "请改用 --patch" in str(exc):
                _print_action_guard(
                    "PATCH_ONLY",
                    "save_report.py --patch",
                    forbidden_extra=["ask_user", "direct_report_edit", "--write"],
                )
                print(
                    "NEXT: 将当前补丁内容改用 save_report.py --patch 提交。",
                    file=sys.stderr,
                )
            else:
                # Retryable write input error (empty stdin, invalid unicode, etc.)
                _print_action_guard(
                    "WRITE_RETRY_ONLY",
                    "save_report.py --write",
                    forbidden_extra=["ask_user", "direct_report_edit"],
                )
                print(
                    "NEXT: 修正完整报告输入后重新使用 save_report.py --write；"
                    "本次未保存，也未消耗完整写入次数。",
                    file=sys.stderr,
                )
        return EXIT_INPUT_ERROR

    if args.min_words is not None:
        # Hard gate: verify the user actually specified this minimum in their original request.
        original_request = ""
        original_path = OUTPUT_DIR / "用户原始问题.md"
        if original_path.is_file():
            try:
                raw_original = original_path.read_text(encoding="utf-8")
                original_request = extract_original_request(raw_original)
            except OSError:
                pass
        user_min = parse_report_min_words(original_request)
        if user_min is None:
            print("MIN_WORDS_NOT_USER_SPECIFIED", file=sys.stderr)
            print(f"RECEIVED_MIN_WORDS: {args.min_words}", file=sys.stderr)
            print(
                "NEXT: 删除 --min-words 参数后重新调用；未指定整体最低字数时使用 advisory policy，不因默认篇幅阻塞。",
                file=sys.stderr,
            )
            return EXIT_INPUT_ERROR
        elif user_min == "ambiguous":
            print("MIN_WORDS_AMBIGUOUS", file=sys.stderr)
            print(f"RECEIVED_MIN_WORDS: {args.min_words}", file=sys.stderr)
            print(
                "NEXT: 用户原始问题包含多个不同 minimum 限制，无法确定哪个是整体报告约束；"
                "删除 --min-words 参数后重新调用，未指定整体最低字数时使用 advisory policy，不因默认篇幅阻塞。",
                file=sys.stderr,
            )
            return EXIT_INPUT_ERROR
        elif args.min_words != user_min:
            print("MIN_WORDS_MISMATCH", file=sys.stderr)
            print(f"USER_SPECIFIED_MIN_WORDS: {user_min}", file=sys.stderr)
            print(f"RECEIVED_MIN_WORDS: {args.min_words}", file=sys.stderr)
            print(f"NEXT: 使用用户明确要求的最低字数 --min-words {user_min}。", file=sys.stderr)
            return EXIT_INPUT_ERROR
        # user_min == args.min_words: validation passed, continue to state update below
        if state.get("explicit_min_words") != args.min_words:
            state["word_reminders_used"] = 0
            state["last_word_reminder_hash"] = None
            state["length_gate_released"] = False
        state["explicit_min_words"] = args.min_words

    # No explicit minimum means there is no length gate at all.
    if state.get("explicit_min_words") is None:
        length_gate_was_released = False
        # Clean legacy state written by older versions where advisory was treated as a gate.
        state["length_gate_released"] = False
    else:
        length_gate_was_released = bool(state.get("length_gate_released"))

    digest = content_hash(markdown)
    render_key = render_fingerprint(digest, language)
    full_write_changed = False
    prior_full_writes = int(state.get("full_writes_used") or 0)
    try:
        if args.write:
            full_write_changed, prior_full_writes = check_full_write_budget(digest, state)
            backup_before_full_rewrite(digest, state)
        if args.write and full_write_changed:
            review_scope = "full"
        elif args.patch and predecessor_rendered:
            review_scope = "targeted"
        else:
            prior_scope = str(state.get("semantic_review_scope") or "full")
            review_scope = prior_scope if prior_scope in {"full", "targeted"} else "full"
        REPORTS_DIR.mkdir(parents=True, exist_ok=True)
        atomic_write_text(REPORT_MD, markdown)
    except ReportError as exc:
        print(f"INPUT_ERROR: {exc}", file=sys.stderr)
        print("SAVED: no", file=sys.stderr)
        print("REPORT_STATUS: UNCHANGED", file=sys.stderr)
        _print_action_guard(
            "PATCH_ONLY",
            "save_report.py --patch",
            forbidden_extra=["ask_user", "direct_report_edit", "--write"],
        )
        print(
            "NEXT: 保留现有 report.md，使用 save_report.py --patch 增量修订。",
            file=sys.stderr,
        )
        return EXIT_INPUT_ERROR
    except OSError as exc:
        print(f"INPUT_ERROR: 无法保存正式 Markdown：{exc}", file=sys.stderr)
        print("SAVED: no", file=sys.stderr)
        retry_mode = "--write" if args.write else "--patch"
        print(
            f"NEXT: 修复文件系统问题后，重新使用 save_report.py {retry_mode}。",
            file=sys.stderr,
        )
        return EXIT_INPUT_ERROR

    try:
        if args.write and full_write_changed:
            state["full_writes_used"] = prior_full_writes + 1
        invalidate_stale_docx(state, render_key)
        state["markdown_hash"] = digest
        state["render_status"] = "saved"
        state["semantic_review_scope"] = review_scope
        state["report_language"] = language
        # C-C: invalidate prior semantic review approval whenever markdown content changes.
        if digest != state.get("semantic_review_hash"):
            state["semantic_review_status"] = None
            state["semantic_review_hash"] = None
        save_state(state)
        save_approved_report(markdown)
    except OSError as exc:
        print(
            f"ENVIRONMENT_ERROR: Markdown 已保存，但无法更新报告状态或内部恢复副本：{exc}",
            file=sys.stderr,
        )
        print(f"SAVED: yes ({REPORT_MD})", file=sys.stderr)
        print(
            "NEXT: 修复环境问题后，将当前完整 report.md 作为 stdin 重新使用 "
            "save_report.py --write；不要重复提交已应用的补丁。",
            file=sys.stderr,
        )
        return EXIT_RENDER_ERROR

    findings, details = validate_report(
        markdown, language, frozen_urls, frozen_sources
    )
    if source_changes:
        shown_changes = "、".join(source_changes[:8])
        suffix = "……" if len(source_changes) > 8 else ""
        findings.warn(
            "首次报告写入后，任务结论或反思材料发生变化；"
            "引用校验仍使用首次快照，后来加入的 URL 不会获得引用资格。"
            f"变化：{shown_changes}{suffix}"
        )
    print(f"SAVED: yes ({REPORT_MD})")
    print("REPORT_SAVED: yes")
    print(f"REPORT_VALID: {'no' if findings.errors else 'yes'}")
    print(f"REPORT_LANGUAGE: {language}")
    if args.write:
        print(f"FULL_WRITES_USED: {state['full_writes_used']}/{DEFAULT_MAX_FULL_WRITES}")
    else:
        print(f"PATCH_APPLIED: {len(patch_details)} replacement(s)")
        for item in patch_details:
            print(
                f"  {item['number']}. original lines "
                f"{item['start_line']}-{item['end_line']}: "
                f"{item['old_chars']} -> {item['new_chars']} chars"
            )
    if not length_gate_was_released or state.get("explicit_min_words") is None:
        if state.get("explicit_min_words") is not None:
            print(f"EFFECTIVE_WORDS: {details['effective_words']}")
    if state.get("explicit_min_words") is None:
        print("LENGTH_POLICY: no_user_minimum")
        print("DO_NOT_EXPAND_FOR_LENGTH: true")
    if _syntax_normalized:
        print("CITATION_SYNTAX: auto_corrected")
    if _was_renumbered:
        print("CITATION_NUMBERING: normalized")
    print("CITATION_NUMBERING_POLICY: script_managed")
    print("CITATION_ORDER_SOURCE: reference_list")
    print("DO_NOT_RENUMBER_FOR_CONTINUITY: true")
    if toc_meta["generated"]:
        print(f"TOC_ENTRIES: {toc_meta['entries']} (heading levels {toc_meta['levels']})")

    if findings.errors:
        state["render_status"] = "blocked"
        save_state(state)
        print("REPORT_SAVED_NEEDS_FIX", file=sys.stderr)
        print_findings(findings)
        print("RENDERED: no", file=sys.stderr)

        # §六 repair guidance: Code labels each deterministic issue's scope and exposes
        # the hard repair budget; the agent decides whole (--write) vs local (--patch).
        # We do NOT force a REPAIR_MODE — only enforce the full-write quota as a hard limit.
        fw_used = int(state.get("full_writes_used") or 0)
        fw_available = fw_used < DEFAULT_MAX_FULL_WRITES
        has_global = False
        print("REPAIR_FINDINGS:", file=sys.stderr)
        for finding_index, finding_message in enumerate(findings.errors, 1):
            scope = classify_finding_scope(finding_message)
            if scope == "GLOBAL":
                has_global = True
            tag = f"[{scope}] " if scope else ""
            print(f"  {finding_index}. {tag}{finding_message.splitlines()[0]}", file=sys.stderr)
        print(f"FULL_WRITE_USED: {fw_used}/{DEFAULT_MAX_FULL_WRITES}", file=sys.stderr)
        print(f"FULL_WRITE_AVAILABLE: {'yes' if fw_available else 'no'}", file=sys.stderr)

        if fw_available:
            print(
                "AVAILABLE_ACTIONS: save_report.py --patch（逐项局部修复）| "
                "save_report.py --write（整体重写，消耗一次 full-write）",
                file=sys.stderr,
            )
            _print_action_guard(
                "REPAIR_CHOICE",
                "save_report.py --patch",
                forbidden_extra=["ask_user", "direct_report_edit"],
            )
        else:
            print(
                "AVAILABLE_ACTIONS: save_report.py --patch（逐项局部修复；full-write 次数已用尽）",
                file=sys.stderr,
            )
            _print_action_guard(
                "PATCH_ONLY",
                "save_report.py --patch",
                forbidden_extra=["ask_user", "direct_report_edit", "--write"],
            )
        if _precheck_errors:
            print(
                "CITATION_FIX_SCOPE: 只修复上面列出的具体 citation/reference/source 问题；"
                "允许修改具体 citation 来修正错误 source/semantic mapping；"
                "不要为了编号连续而修改其他无关 [^n]。",
                file=sys.stderr,
            )

        # Item 7: consolidate ALL unauthorized web URLs into one machine-parseable
        # block. Code only lists them + the rule; it never auto-deletes/replaces/adds.
        if frozen_urls:
            _body_without_defs = REFERENCE_DEF_RE.sub("", markdown)
            _seen: set[str] = set()
            _unauthorized: list[str] = []
            for _m in REFERENCE_DEF_RE.finditer(markdown):
                for _u in extract_urls(_m.group(2)):
                    if is_placeholder_url(_u):
                        continue
                    _n = normalize_url(_u)
                    if _n not in frozen_urls and _n not in _seen:
                        _seen.add(_n)
                        _unauthorized.append(_u)
            for _u in extract_urls(_body_without_defs):
                if is_placeholder_url(_u):
                    continue
                _n = normalize_url(_u)
                if _n not in frozen_urls and _n not in _seen:
                    _seen.add(_n)
                    _unauthorized.append(_u)
            if _unauthorized:
                print("REPORT_SOURCE_ERROR: UNAUTHORIZED_URL", file=sys.stderr)
                print("UNAUTHORIZED_URLS:", file=sys.stderr)
                for _u in _unauthorized:
                    print(f"  - {_u}", file=sys.stderr)
                print(
                    "RULE: report web citations must use only frozen allowed URLs",
                    file=sys.stderr,
                )
                print("USE_ONLY_FROZEN_SOURCE_CATALOG: true", file=sys.stderr)
        if has_global and fw_available:
            print(
                "NEXT: 存在 [GLOBAL] 级问题——可整体重写(--write)或逐项局部修复(--patch)，"
                "由你判断改写范围；仅 [LOCAL] 问题时优先使用 --patch。",
                file=sys.stderr,
            )
        elif fw_available:
            print(
                "NEXT: 上述均为 [LOCAL] 或未定级问题，优先使用 save_report.py --patch "
                "逐项修订已保存的 report.md。",
                file=sys.stderr,
            )
        else:
            print(
                "NEXT: full-write 次数已用尽，使用 save_report.py --patch 逐项修订已保存的 report.md。",
                file=sys.stderr,
            )
        return EXIT_NEEDS_REVISION

    word_status, word_message = handle_word_gate(details["effective_words"], digest, state)
    if word_status in {"remind", "pending", "explicit_block"}:
        state["render_status"] = "word_blocked"
        if state.get("explicit_min_words") is not None:
            state["length_gate_released"] = False
        save_state(state)
        status_name = {
            "remind": "REPORT_SAVED_LENGTH_REMINDER",
            "pending": "REPORT_SAVED_LENGTH_PENDING",
            "explicit_block": "REPORT_SAVED_LENGTH_EXPLICIT_BLOCK",
        }[word_status]
        print(status_name, file=sys.stderr)
        print(word_message, file=sys.stderr)
        print_findings(findings)
        print("RENDERED: no", file=sys.stderr)
        _print_action_guard(
            "PATCH_ONLY",
            "save_report.py --patch",
            forbidden_extra=["ask_user", "direct_report_edit", "--write"],
            no_user_confirmation=True,
        )
        if word_status == "pending":
            print(
                "NEXT: 不要重复提交相同内容；使用 save_report.py --patch 实际补充已有内容。",
                file=sys.stderr,
            )
        else:
            print(
                "NEXT: 使用 save_report.py --patch 增量展开已有内容。",
                file=sys.stderr,
            )
        return EXIT_NEEDS_REVISION
    if word_message:
        findings.warn(word_message)
    # Only an explicit user minimum has a real length gate.
    length_gate_released = (
        state.get("explicit_min_words") is not None
        and word_status == "pass"
    )
    length_gate_just_released = length_gate_released and not length_gate_was_released
    if length_gate_released:
        state["length_gate_released"] = True
    else:
        state["length_gate_released"] = False
    save_state(state)

    if state.get("rendered_hash") == render_key and REPORT_DOCX.is_file():
        state["render_status"] = "rendered"
        save_state(state)
        print("REPORT_SAVED_AND_RENDERED")
        print(f"RENDERED: unchanged ({REPORT_DOCX})")
        print_findings(findings)
        print_delivery_next(length_gate_released, length_gate_just_released, review_scope)
        return EXIT_OK

    model = build_render_model(markdown, digest, details, language)
    rendered, render_errors = run_renderer(model, digest)
    if not rendered:
        state["render_status"] = "render_failed"
        save_state(state)
        print("RENDER_FAILED", file=sys.stderr)
        for index, message in enumerate(render_errors, 1):
            print(f"  {index}. {message}", file=sys.stderr)
        print_findings(findings)
        print("RENDERED: no", file=sys.stderr)
        print(
            "NEXT: 修复上述渲染环境问题后，将当前完整 report.md 作为 stdin 重新使用 "
            "save_report.py --write；不要直接调用 report_renderer.js。",
            file=sys.stderr,
        )
        return EXIT_RENDER_ERROR

    state["rendered_hash"] = render_key
    state["render_status"] = "rendered"
    save_state(state)
    if findings.warnings:
        print("REPORT_SAVED_WITH_WARNINGS_AND_RENDERED")
    else:
        print("REPORT_SAVED_AND_RENDERED")
    print(f"RENDERED: yes ({REPORT_DOCX})")
    print_findings(findings)
    print_delivery_next(length_gate_released, length_gate_just_released, review_scope)
    return EXIT_OK


if __name__ == "__main__":
    try:
        exit_code = main()
    except OSError as exc:
        print(f"ENVIRONMENT_ERROR: 文件系统操作失败：{exc}", file=sys.stderr)
        exit_code = EXIT_RENDER_ERROR
    raise SystemExit(exit_code)
