#!/usr/bin/env python3
"""Save a task/reflection conclusion with structural field validation (no word limit).

进度门（详见 task_progress.py）：
- --type task 时，--task-id 必须等于指针（第一个还不是 validated 的任务号），否则 die，
  不要求本号刚 search/fetch 过。唯一例外：该号已是 validated artifact（回改已完成任务的结论），
  允许覆盖，但需 --force（且不改变指针/待写进度）。
- --type reflection 时，要求任务结论已全部 validated（每个任务号都有认证过的 task_N.md），否则 die。
- 「完成」= validated artifact：正式文件存在 + outputs/research/conclusion_state.json 有记录 +
  当前 SHA-256 与记录一致。仅磁盘存在（编辑器直写 / 手写 / 被改动）不算完成；此时正常
  save_conclusion（不加 --force）会重新校验并接管该文件（收编/修复），--force 只用于对已
  validated 结论的合法修订。
- 保存成功（正式文件写入 + provenance 原子写入）后按 provenance 重新同步 研究任务.json，
  并在 stdout 追加完成进度 / 待写编号。
- 字段校验（标题、必填段落、关键结论编号+依据等）会跑完全部检查后一次性报告所有
  问题，而不是查到第一条就退出。
"""

import argparse
import os
import re
import select
import shutil
import sys
from pathlib import Path

import task_progress as tp


_STDIN_WAIT_SECONDS = 3


# --- 自动推断项目根路径（不依赖 cwd）---
# 本脚本位置：<project_root>/.skills/deepresearch/scripts/save_conclusion.py
# 项目根：向上 3 级
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
DEFAULT_PROJECT_ROOT = os.path.abspath(os.path.join(SCRIPT_DIR, "..", "..", ".."))
DEFAULT_OUTPUT_DIR = os.path.join(DEFAULT_PROJECT_ROOT, "outputs")


# --- Required sections per conclusion type ---
TASK_REQUIRED = [
    "对应研究问题或主题",
    "结论摘要",
    "关键结论",
    "信息缺口与写作提醒",
]

REFLECTION_REQUIRED = [
    "检查结果",
    "修正与补充",
    "报告写作提醒",
]


# --- 字段名等价写法（中英文别名）---
# 仅放宽“语法/别名”识别，不降低语义门槛：每个必填字段接受其常见中英文等价名，
# 且标题行可用 Markdown 标题（#~######）或粗体两种写法（见 extract_section）。
FIELD_ALIASES = {
    "对应研究问题或主题": [
        "对应研究问题或主题", "对应研究问题", "研究问题或主题",
        "corresponding research question or theme",
        "corresponding research question or topic",
        "corresponding research question", "research question or theme",
    ],
    "结论摘要": ["结论摘要", "conclusion summary", "summary of conclusions"],
    "关键结论": ["关键结论", "key conclusions", "key conclusion", "key findings"],
    "信息缺口与写作提醒": [
        "信息缺口与写作提醒", "信息缺口和写作提醒", "信息缺口",
        "information gaps and writing reminders",
        "information gaps & writing reminders", "information gaps",
    ],
    "检查结果": ["检查结果", "review results", "check results"],
    "修正与补充": ["修正与补充", "corrections and additions", "corrections & additions"],
    "报告写作提醒": ["报告写作提醒", "report writing reminders", "writing reminders"],
}


def _cn_numeral(n):
    """把 1..10 映射为中文数字，供标题接受「任务一」这类等价写法；越界返回 None。"""
    table = {
        1: "一", 2: "二", 3: "三", 4: "四", 5: "五",
        6: "六", 7: "七", 8: "八", 9: "九", 10: "十",
    }
    return table.get(n)


def _field_header_re(canonical_names):
    """构造能识别给定字段（含别名）标题行的正则。

    接受两种等价写法：Markdown 标题（`#`~`######`）或粗体（`**名**` / `*名*`）；
    名称后允许可选的粗体闭合、可选冒号与同一行的内联内容。要求必须带 `#` 或 `*`
    前缀，避免正文里出现同名短语被误当作字段标题。
    """
    aliases = []
    for canon in canonical_names:
        aliases.extend(FIELD_ALIASES.get(canon, [canon]))
    alias_re = "|".join(
        re.escape(a) for a in sorted(set(aliases), key=len, reverse=True)
    )
    return re.compile(
        rf"(?im)^[ \t]{{0,3}}(?:#{{1,6}}[ \t]*|(?:\*\*|\*)[ \t]*)"
        rf"(?:{alias_re})"
        rf"[ \t]*(?:\*\*|\*)?[ \t]*[:：]?[ \t]*(.*)$"
    )


# --- 依据（证据）标记识别 ---
# 支持三种书写：(1) 行首列表 `- 依据：...`；(2) 句末内联 `……结论。依据（网页）：…https://…`；
# (3) 括号内联 `……（依据：[标题](url)）`。别名：依据 / 依据综合 / 综合依据 / Evidence / Source。
# 语义门槛不变：无括号（含英文 Evidence/Source）或括号含「网页」→ 网页型，必须含 http(s) URL；
# 「依据综合」「综合依据」视为“综合判断”类（非网页），只要求内容非空。
_EVIDENCE_MARKER_RE = re.compile(
    r"(?:(?<=^)|(?<=[\s（(【\[、，,。；;：:]))"   # 行首或分隔符之后
    r"(?:\*\*)?"                                   # 可选粗体开
    r"(?P<marker>依据综合|综合依据|依据|Evidence|Source)"
    r"(?:[（(]\s*(?P<cat>[^）)]*?)\s*[)）])?"       # 可选 (类别)
    r"(?:\*\*)?"                                   # 可选粗体闭
    r"[ \t]*[:：]",                                # 必须有半/全角冒号
    re.IGNORECASE,
)

URL_PATTERN = re.compile(r"https?://\S+", re.IGNORECASE)

# Accepted evidence formats, derived from the real is_web_evidence() rule below
# (single source of truth — do not maintain a second copy elsewhere): a 网页型
# 依据 (no bracket, or bracket text containing「网页」) must carry an http(s) URL;
# any other bracketed label only needs non-empty content.
ACCEPTED_EVIDENCE_FORMATS = (
    "依据（网页）：<来源标题> https://…（网页型依据必须含 http(s) URL）"
    " | 依据（文件）：<本地文件或路径>"
    " | 依据（计算）：<计算过程>"
    " | 依据（综合判断）：<推理说明>"
    "（无括号或括号含「网页」→按网页型校验，必须有 URL；其他带括号标签只需内容非空）"
)

# --- P0-1: 把结论中引用的本地抓取缓存映射回其来源 URL ---
_FETCH_REF_RE = re.compile(r"fetch_[A-Za-z0-9_]+\.md")
_FETCH_URL_HEADER_RE = re.compile(r"<!--\s*url:\s*(https?://\S+?)\s*-->", re.IGNORECASE)
_RESOLVED_BEGIN = "<!-- resolved-sources: begin -->"
_RESOLVED_END = "<!-- resolved-sources: end -->"
_RESOLVED_BLOCK_RE = re.compile(
    re.escape(_RESOLVED_BEGIN) + r".*?" + re.escape(_RESOLVED_END),
    re.DOTALL,
)


def resolve_fetch_source_urls(content, output_dir):
    """Map fetch_*.md caches actually cited in the conclusion to their source URL.

    Only files that (a) are referenced in the conclusion text and (b) exist under
    outputs/research/ with a reliable ``<!-- url: ... -->`` header are resolved.
    Never invents a URL for an unreferenced or headerless file, and never scans
    the whole research log.
    """
    research_dir = Path(output_dir) / "research"
    resolved = {}
    for name in dict.fromkeys(_FETCH_REF_RE.findall(content)):
        fpath = research_dir / name
        if not fpath.is_file():
            continue
        try:
            head = fpath.read_text(encoding="utf-8")[:2048]
        except OSError:
            continue
        m = _FETCH_URL_HEADER_RE.search(head)
        if m:
            resolved[name] = m.group(1)
    return resolved


def augment_with_resolved_sources(content, output_dir):
    """Append a deterministic provenance block resolving cited fetch_*.md → source URL.

    Idempotent: strips any prior resolved-sources block before recomputing, so the
    resolved URLs enter the saved conclusion/reflection text and the Report source
    snapshot can recognise them. Returns text ending with a single newline.
    """
    base = _RESOLVED_BLOCK_RE.sub("", content).rstrip()
    resolved = resolve_fetch_source_urls(base, output_dir)
    if not resolved:
        return base + "\n"
    lines = [
        _RESOLVED_BEGIN,
        "<!-- 自动生成：把结论引用的本地抓取缓存映射回来源 URL，供报告来源校验识别。 -->",
    ]
    for name in sorted(resolved):
        lines.append(f"- {name} {resolved[name]}")
    lines.append(_RESOLVED_END)
    return base + "\n\n" + "\n".join(lines) + "\n"


def read_stdin():
    """Read conclusion from stdin with TTY/timeout guard (mirrors save_report.read_stdin).

    - TTY → immediate error (bare invocation without heredoc/pipe)
    - Non-TTY but no data within _STDIN_WAIT_SECONDS → timeout error
    - EOF but empty → error
    - Has content → return stripped string
    """
    if sys.stdin.isatty():
        die(
            "未收到 stdin。结论正文必须与命令在同一次调用中传入，"
            "例如：python save_conclusion.py --type task --task-id 1 << 'EOF' ... EOF"
        )
    if os.name != "nt":
        try:
            readable, _, _ = select.select([sys.stdin], [], [], _STDIN_WAIT_SECONDS)
        except (OSError, ValueError):
            readable = [sys.stdin]
        if not readable:
            die(
                f"{_STDIN_WAIT_SECONDS} 秒内未收到 stdin。"
                "结论正文必须与命令在同一次调用中传入。"
            )
    content = sys.stdin.read().strip()
    if not content:
        die("stdin 内容为空。结论正文必须与命令在同一次调用中传入。")
    return content


def read_stdin_optional():
    """Return stripped stdin text, or None when no content is supplied.

    Unlike read_stdin(), this never dies: a TTY, an empty pipe, or a read
    timeout all yield None. Used by the reflection ``--complete`` transition-only
    path, which re-reads an existing round file instead of requiring new stdin.
    """
    if sys.stdin.isatty():
        return None
    if os.name != "nt":
        try:
            readable, _, _ = select.select([sys.stdin], [], [], _STDIN_WAIT_SECONDS)
        except (OSError, ValueError):
            readable = [sys.stdin]
        if not readable:
            return None
    content = sys.stdin.read().strip()
    return content or None


def die(msg):
    """打印错误信息并以非零状态退出（附带重新调用的提示）。"""
    print(f"ERROR: {msg}", file=sys.stderr)
    print("请修正上述问题后重新调用 save_conclusion.py。", file=sys.stderr)
    sys.exit(1)


class FieldErrors:
    """收集字段校验问题，跑完全部检查后一次性报告，而不是查到第一条就退出。

    每条问题除人类可读描述外，可携带机械可解析的 ERROR_CODE / ITEM / ACCEPTED_FORMAT，
    让 Agent 一次拿到全部问题及其合法格式，而不必逐条试错。
    """

    def __init__(self):
        """初始化空的问题列表。"""
        self.items = []

    def add(self, msg, *, code=None, item=None, accepted=None):
        """追加一条校验问题；code/item/accepted 为可选的结构化补充信息。"""
        self.items.append(
            {"msg": msg, "code": code, "item": item, "accepted": accepted}
        )

    def raise_if_any(self):
        """若已收集到问题，则逐条打印后以非零状态退出；否则直接返回。"""
        if not self.items:
            return
        print(f"ERROR: 结论校验未通过，共 {len(self.items)} 处问题：", file=sys.stderr)
        for i, entry in enumerate(self.items, 1):
            print(f"  {i}. {entry['msg']}", file=sys.stderr)
            if entry.get("code"):
                print(f"     ERROR_CODE: {entry['code']}", file=sys.stderr)
            if entry.get("item"):
                print(f"     ITEM: {entry['item']}", file=sys.stderr)
            if entry.get("accepted"):
                print(f"     ACCEPTED_FORMAT: {entry['accepted']}", file=sys.stderr)
        print("请修正以上全部问题后重新调用 save_conclusion.py。", file=sys.stderr)
        sys.exit(1)


def count_words(content):
    """Rough word count: Chinese chars + English words."""
    zh = len(re.findall(r"[\u4e00-\u9fff]", content))
    en = len(re.findall(r"[a-zA-Z]+", content))
    return zh + en


def extract_section(content, section_name, all_sections, errors):
    """Extract a non-empty section delimited by the required field headings.

    放宽“语法”：字段标题接受 Markdown 标题（`#`~`######`）或粗体两种写法，
    并接受该字段的常见中英文别名（见 FIELD_ALIASES）；名称后可带冒号与同行内联内容。
    语义门槛不变：字段缺失/为空仍记录到 errors 并返回 None。
    """
    start_re = _field_header_re([section_name])
    boundary_re = _field_header_re(all_sections)

    match = start_re.search(content)
    if not match:
        errors.add(f"缺少字段：**{section_name}**", code="MISSING_FIELD", item=section_name)
        return None

    inline = (match.group(1) or "").strip()
    body_start = match.end()
    nxt = boundary_re.search(content, body_start)
    body_end = nxt.start() if nxt else len(content)
    tail = content[body_start:body_end].strip()
    body = (inline + "\n" + tail).strip() if inline else tail
    if not body:
        errors.add(f"字段内容为空：**{section_name}**", code="EMPTY_FIELD", item=section_name)
        return None
    return body


_PLACEHOLDER_RE = re.compile(r"\bTODO\b|\bTBD\b|待填写|\[\s*请填写\s*\]", re.IGNORECASE)


def _mask_non_prose(content):
    """Blank out spans where a placeholder token is not real prose.

    Removes inline code, URLs, Markdown link targets, and path-like tokens
    (anything with a slash/backslash or ending in a filename extension) so that
    substrings such as ``/mtbd/article``, ``/tbd/article`` or
    ``fetch_x_mtbd_y.md`` never trip the placeholder check, while a genuine
    "TBD" / "TODO" in body text still does.
    """
    text = re.sub(r"`[^`]*`", " ", content)          # inline code spans
    text = re.sub(r"https?://\S+", " ", text)          # bare URLs
    text = re.sub(r"\]\([^)]*\)", "]( )", text)         # Markdown link/image targets
    text = re.sub(r"\S*[/\\]\S*", " ", text)            # path-like tokens
    text = re.sub(r"\S+\.[A-Za-z0-9]{1,5}\b", " ", text)  # bare filenames
    return text


def reject_placeholders(content, errors):
    """检测 TODO / TBD / 待填写 等占位内容，发现即记录为校验问题。

    只在真实正文上匹配：先屏蔽 URL、链接目标与文件路径，避免 `/mtbd/`、
    `fetch_x_mtbd_y.md` 这类合法内容里的 "tbd" 子串造成误报。
    """
    placeholders = _PLACEHOLDER_RE.search(_mask_non_prose(content))
    if placeholders:
        errors.add(
            f"存在未完成的占位内容：{placeholders.group(0)}", code="PLACEHOLDER"
        )


def split_numbered_items(body):
    """把「关键结论」正文按行首编号（1. / 1、）拆成若干条目。

    返回 [(index_str, item_text), ...]；未识别到编号时返回空列表。
    """
    # 用 (?m) 让 ^ 匹配行首；行首允许若干空白后紧跟数字 + . 或 、
    marker_re = re.compile(r"(?m)^\s*(\d+)\s*[\.、]\s+")
    matches = list(marker_re.finditer(body))
    if not matches:
        return []
    items = []
    for i, m in enumerate(matches):
        start = m.end()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(body)
        text = body[start:end].strip()
        items.append((m.group(1), text))
    return items


def iter_evidence_lines(text):
    """扫描文本，yield (category, remainder) 依据条目。

    支持行首列表、句末内联、括号内联三种书写与中英文别名（见 _EVIDENCE_MARKER_RE）。
    每个标记的正文取到下一个标记之前（可跨行，容纳「依据：」后另起子条目列出的来源）。

    category:
      - None    → 无括号（含英文 Evidence/Source），视为网页型（需要 URL）
      - "综合"  → 「依据综合」「综合依据」等综合判断类（非网页）
      - str     → 括号里的标注内容（如「网页」「文件」「计算」「综合判断」…）
    remainder: 依据正文（已去除首尾空白与残留列表符号）。
    """
    matches = list(_EVIDENCE_MARKER_RE.finditer(text))
    for i, m in enumerate(matches):
        marker = m.group("marker")
        category = m.group("cat")
        if category is not None:
            category = category.strip()
        elif marker in ("依据综合", "综合依据"):
            category = "综合"
        start = m.end()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
        remainder = text[start:end].strip()
        remainder = re.sub(r"[\s\-*+]+$", "", remainder)
        yield category, remainder


def _evidence_marker_line(remainder):
    """返回依据标记自身所在行的正文（首个换行前）。

    网页型依据要求 URL 与「依据（网页）/Evidence/Source」标记同处一行，避免同一
    关键结论后文出现的无关 URL 被误当作该依据的来源而放行（否则缺 URL 的网页依据
    会被后续无关链接“搭救”，绕过 EVIDENCE_MISSING_URL）。
    """
    return remainder.split("\n", 1)[0] if remainder else ""


def is_web_evidence(category):
    """无括号 或 括号内容含「网页」→ 视为网页型，要求 URL。"""
    if category is None:
        return True
    return "网页" in category


def validate_task_key_conclusions(content, errors):
    """对「关键结论」段落做编号列表与依据完整性校验。"""
    body = extract_section(content, "关键结论", TASK_REQUIRED, errors)
    if body is None:
        return  # 缺失/为空已记录，无正文可继续拆条目

    items = split_numbered_items(body)
    if not items:
        errors.add(
            "「关键结论」必须使用编号列表（形如 `1. ...` 或 `1、...`），"
            "只用粗体小标题的段落式写法会被拒绝。",
            code="KEY_CONCLUSION_NOT_NUMBERED",
            item="关键结论",
        )
        return
    for idx, text in items:
        evidences = list(iter_evidence_lines(text))
        if not evidences:
            errors.add(
                f"关键结论第 {idx} 条缺少依据行（`- 依据：...`）。",
                code="EVIDENCE_MISSING",
                item=f"KEY_CONCLUSION_{idx}",
                accepted=ACCEPTED_EVIDENCE_FORMATS,
            )
            continue
        for category, remainder in evidences:
            if not remainder:
                label = "依据" if category is None else f"依据（{category}）"
                errors.add(
                    f"关键结论第 {idx} 条的「{label}」内容为空。",
                    code="EVIDENCE_EMPTY",
                    item=f"KEY_CONCLUSION_{idx}",
                    accepted=ACCEPTED_EVIDENCE_FORMATS,
                )
                continue
            if is_web_evidence(category) and not URL_PATTERN.search(_evidence_marker_line(remainder)):
                label = "依据" if category is None else f"依据（{category}）"
                errors.add(
                    f"关键结论第 {idx} 条的「{label}」缺少具体 URL（需包含 http:// 或 https://）；"
                    "如属本地文件、计算或综合判断，请改用「依据（文件）」「依据（计算）」"
                    "或「依据（综合判断）」等带括号的依据标签。",
                    code="EVIDENCE_MISSING_URL",
                    item=f"KEY_CONCLUSION_{idx}",
                    accepted=ACCEPTED_EVIDENCE_FORMATS,
                )


def validate_reflection_evidence(content, errors):
    """反思结论中若出现网页依据，必须包含 URL。"""
    for section in ("检查结果", "修正与补充"):
        body = extract_section(content, section, REFLECTION_REQUIRED, errors)
        if body is None:
            continue
        for category, remainder in iter_evidence_lines(body):
            if not remainder:
                label = "依据" if category is None else f"依据（{category}）"
                errors.add(
                    f"反思「{section}」中「{label}」内容为空。",
                    code="EVIDENCE_EMPTY",
                    item=section,
                    accepted=ACCEPTED_EVIDENCE_FORMATS,
                )
                continue
            if is_web_evidence(category) and not URL_PATTERN.search(_evidence_marker_line(remainder)):
                label = "依据" if category is None else f"依据（{category}）"
                errors.add(
                    f"反思「{section}」中「{label}」缺少具体 URL（需包含 http:// 或 https://）；"
                    "如属本地文件、计算或综合判断，请使用带括号的依据标签。",
                    code="EVIDENCE_MISSING_URL",
                    item=section,
                    accepted=ACCEPTED_EVIDENCE_FORMATS,
                )


def validate_task(content, task_id, errors):
    """校验任务结论：标题格式、必填段落、占位内容与关键结论的编号/依据。"""
    num = str(task_id)
    cn = _cn_numeral(task_id)
    num_alt = num if cn is None else f"(?:{num}|{cn})"
    # 标题接受等价写法：任意 Markdown 标题层级、可选粗体、中/英「任务N」「Task N」
    # （英文可带 Conclusion），编号后跟冒号/顿号/点/破折号/空白再接非空标题文字。
    title_pattern = (
        rf"(?im)^[ \t]{{0,3}}#{{1,6}}[ \t]*(?:\*\*[ \t]*)?"
        rf"(?:任务|task)[ \t]*{num_alt}\b(?:[ \t]*conclusion)?"
        rf"[ \t]*[：:．.、\-\s][ \t]*\S"
    )
    if not re.search(title_pattern, content):
        errors.add(
            f"标题必须是：### 任务 {task_id}：任务标题"
            f"（也接受等价写法，如 ### Task {task_id}: Title 或 ### 任务{cn or task_id}：标题）",
            code="BAD_TITLE",
            item=f"任务 {task_id}",
        )

    for section in TASK_REQUIRED:
        if section == "关键结论":
            continue  # 由 validate_task_key_conclusions 统一校验，避免重复报错
        extract_section(content, section, TASK_REQUIRED, errors)
    reject_placeholders(content, errors)
    validate_task_key_conclusions(content, errors)


def validate_reflection(content, round_id, errors):
    """校验反思结论：标题格式、必填段落、占位内容与网页依据的 URL。"""
    title_pattern = rf"(?m)^###\s*反思第\s*{round_id}\s*轮\s*$"
    if not re.search(title_pattern, content):
        errors.add(
            f"标题必须是：### 反思第 {round_id} 轮",
            code="BAD_TITLE",
            item=f"反思第 {round_id} 轮",
        )

    for section in REFLECTION_REQUIRED:
        if section in ("检查结果", "修正与补充"):
            continue  # 由 validate_reflection_evidence 统一校验，避免重复报错
        extract_section(content, section, REFLECTION_REQUIRED, errors)
    reject_placeholders(content, errors)
    validate_reflection_evidence(content, errors)


def validate(content, conclusion_type, task_id=None, round_id=None):
    """跑完所有字段检查后一次性报告全部问题，而不是查到第一条就退出。"""
    errors = FieldErrors()
    if conclusion_type == "task":
        validate_task(content, task_id, errors)
    else:
        validate_reflection(content, round_id, errors)
    errors.raise_if_any()


def resolve_target(args):
    """根据结论类型推导写入路径，返回 (目标目录, 目标文件, 展示用标签)。"""
    if args.type == "task":
        target_dir = os.path.join(args.output_dir, "conclusions")
        target = os.path.join(target_dir, f"task_{args.task_id}.md")
        label = f"task_{args.task_id}.md"
    else:
        target_dir = os.path.join(args.output_dir, "reflection")
        target = os.path.join(target_dir, f"round_{args.round}.md")
        label = f"reflection/round_{args.round}.md"
    return target_dir, target, label


def resolve_output_dir(raw_output_dir):
    """把 --output-dir 参数解析为绝对路径，并对可疑相对路径发出警告。

    未显式传入时交给 task_progress.resolve_output_dir 推断，保证与
    baidu_search.py / fetch_webpage.py 落在同一个 outputs 目录。
    返回 (output_dir, probed)。
    """
    if not raw_output_dir:
        return tp.resolve_output_dir(__file__)
    if os.path.isabs(raw_output_dir):
        return raw_output_dir, []
    abs_path = os.path.abspath(raw_output_dir)
    print(
        f"WARNING: --output-dir 是相对路径 ({raw_output_dir!r}), "
        f"已按当前 cwd 拼接为绝对路径 {abs_path!r}。"
        f"若结果与预期项目根不符，请显式传入绝对路径。",
        file=sys.stderr,
    )
    return abs_path, []


MAX_REFLECTION_ROUNDS = 2


def next_reflection_round(output_dir):
    """下一轮编号 = 已 validated 的最大 reflection round + 1（至少 1）。

    只数经 save_conclusion 认证过的 validated round；编辑器直写 / 手写 / 被改动的
    round_*.md 不计入，避免未认证文件把编号推进到下一轮。
    """
    validated = tp.validated_reflection_rounds(output_dir)
    return (max(validated) + 1) if validated else 1


def reflection_schema_lines(round_id):
    """返回反思结论的标题 + 三个必填段落标签（供 Agent 逐字对齐，Code 不代写内容）。"""
    lines = [f"### 反思第 {round_id} 轮"]
    for section in REFLECTION_REQUIRED:
        lines.append(f"**{section}**")
    return lines



def load_save_report(output_dir):
    """Import save_report.py bound to a deterministic output_dir (returns module or None)."""
    save_report_py = Path(SCRIPT_DIR) / "save_report.py"
    try:
        import importlib.util as _ilu
        spec = _ilu.spec_from_file_location("save_report", str(save_report_py))
        module = _ilu.module_from_spec(spec)
        spec.loader.exec_module(module)
        module.configure_runtime_paths_for(output_dir)
        return module
    except Exception as exc:
        print(
            f"WARNING: 无法加载 save_report.py（{exc}），报告语言/冻结检查降级为默认值。",
            file=sys.stderr,
        )
        return None


def report_inputs_frozen(sr):
    """Return True if the report source snapshot has been frozen at Stage6."""
    if sr is None:
        return False
    try:
        return bool(sr.load_state().get("report_inputs_frozen"))
    except Exception:
        return False


# 仅在“原始问题显式含排名/Top-N 意图”时，才在交接里补一条 RANKING_GUARD；
# 普通问题不触发。只做关键词匹配，不做语义打分。
_RANKING_INTENT_RE = re.compile(
    r"(top\s*-?\s*\d+|top\s*n|前\s*[0-9一二三四五六七八九十百]+\s*(名|强|大|位|个)?|"
    r"排名|排行|榜单|名次|rank(ing)?)",
    re.IGNORECASE,
)


def _has_ranking_intent(text):
    return bool(text) and bool(_RANKING_INTENT_RE.search(text))



def emit_stage6_handoff(sr, output_dir, snapshot):
    """Emit the Reflection→Stage6 handoff contract (language lock, length policy, action guard).

    Only called after the source snapshot has been frozen successfully.
    """
    _report_language = "zh-CN"
    _user_min_words = None
    _ranking_intent = False
    if sr is not None:
        try:
            _report_language = sr.detect_report_language()
        except Exception as exc:
            print(
                f"WARNING: 无法从 save_report.py 读取报告语言（{exc}），默认使用 zh-CN",
                file=sys.stderr,
            )
        try:
            _orig_path = Path(output_dir) / "用户原始问题.md"
            if _orig_path.is_file():
                _orig_text = _orig_path.read_text(encoding="utf-8")
                _req = sr.extract_original_request(_orig_text) or _orig_text
                _val = sr.parse_report_min_words(_req)
                if isinstance(_val, int):
                    _user_min_words = _val
                _ranking_intent = _has_ranking_intent(_req)
        except Exception as exc2:
            print(f"WARNING: 无法解析用户指定最低字数（{exc2}）", file=sys.stderr)

    _length_policy = (
        f"EXPLICIT_MIN_WORDS: {_user_min_words}（用户指定）"
        if _user_min_words
        else "NO_USER_MINIMUM: 不存在字数门槛；DO_NOT_EXPAND_FOR_LENGTH: true"
    )
    _min_words_flag = f" --min-words {_user_min_words}" if _user_min_words else ""

    print("WORKFLOW_STATE: STAGE6_READY")
    print("RESEARCH_STATUS: CLOSED")
    print("REPORT_INPUTS_FROZEN: yes")
    if isinstance(snapshot, dict):
        print(f"FROZEN_SOURCE_FILES: {len(snapshot.get('files', []))}")
        _allowed_urls = snapshot.get("allowed_urls", []) or []
        print(f"FROZEN_ALLOWED_URLS: {len(_allowed_urls)}")
        _title_by_url = {}
        for _src in snapshot.get("sources", []) or []:
            if not isinstance(_src, dict):
                continue
            _u = _src.get("normalized_url")
            _t = (_src.get("title") or "").strip()
            if _u and _u not in _title_by_url and _t:
                _title_by_url[_u] = _t
        print("FROZEN_SOURCE_CATALOG:")
        for _u in _allowed_urls:
            _t = _title_by_url.get(_u)
            if _t:
                print(f"  - {_t} — {_u}")
            else:
                print(f"  - {_u}")
        print("REPORT_SOURCE_RULE: 报告中的网页引用只能使用 FROZEN_SOURCE_CATALOG 中的 exact URL")
        print("NEW_WEB_SOURCE_ALLOWED: false")
    print(f"REPORT_LANGUAGE: {_report_language}")
    _lang_label = {
        "zh-CN": "中文（简体）",
        "en-US": "English",
    }.get(_report_language, _report_language)
    print("REPORT_LANGUAGE_LOCKED: yes")
    print(f"REQUIRED_REPORT_LANGUAGE: {_report_language}")
    print(f"REPORT_BODY_MUST_USE: {_lang_label}")
    print("CONVERSATION_LANGUAGE_DOES_NOT_OVERRIDE_REPORT_LANGUAGE: true")
    print(
        f"NOTE: 报告正文（标题、摘要、章节、结论、参考文献标题）必须全部使用"
        f" {_lang_label}，与对话语言无关；"
        "引用来源的标题和 URL 保持原文，专有名词保留，其余内容必须使用报告语言。"
    )
    print(f"LENGTH_POLICY: {_length_policy}")
    if _ranking_intent:
        print(
            "RANKING_GUARD: 原始问题含排名/Top-N 意图。精确 Top-N 仅在 N 个对象具备"
            "同一排序指标、同单位、同口径的可比证据时给出；证据不足时只排序可比对象或"
            "改为不排名的代表性案例，禁止未经用户明确要求混用代理指标或自建综合评分补齐名次。"
        )
    print("ACTION_GUARD: REPORT_WRITE_ONLY")
    print("FORBIDDEN: baidu_search.py | fetch_webpage.py | ask_user | "
          "direct_report_edit | shadow_report_draft | temporary_report_draft | "
          "new_report*.md类草稿 | word_count | wc -w | wc -l | "
          "internal_report_state | output_pipeline | "
          "docx_skill | web-reader | baidu-ai-search")
    print("  internal_report_state 包括：.report_cache 和 report_state.json")
    print(f"NEXT_TOOL: save_report.py --write{_min_words_flag}")
    print("INPUT_MODE: heredoc（报告全文通过 stdin heredoc 与命令同次调用传入；"
          "不得提前另建草稿文件，不得分多次调用）")
    print("NOTE: 直接调用 save_report.py；禁止通过 | head / | tail 等 pipeline 截断输出，"
          "否则真实 exit code 和 NEXT 会丢失")


def emit_reflection_continue(round_id):
    """Emit the Case-A (no --complete) reflection contract: research stays OPEN."""
    print("WORKFLOW_STATE: REFLECTION_CONTINUE")
    print("RESEARCH_STATUS: OPEN")
    print("FINAL_REPORT_READY: no")
    print("INTERACTION_RULE: NO_ASK_USER")
    print(
        "NOTE: 反思结论已保存，但研究尚未收敛。是否充分由你（Agent）判断——"
        "若仍有信息缺口，可在 reflection 阶段继续 baidu_search.py / fetch_webpage.py 补充；"
        "若已充分，请再次以 --complete 调用本命令收敛并进入报告阶段。"
    )
    print(
        f"NEXT_IF_SUFFICIENT: save_conclusion.py --type reflection --round {round_id} --complete"
    )
    print("STDIN_REQUIRED: no")
    print("DO_NOT_RESUBMIT_SAVED_REFLECTION: true")
    print(
        f"NOTE: 第 {round_id} 轮反思正文已落盘，转入报告阶段的 --complete 仅做状态收敛，"
        "无需再次通过 stdin 重贴反思全文。"
    )
    if round_id >= MAX_REFLECTION_ROUNDS:
        print(
            f"NOTE: 已达反思轮次上限（{MAX_REFLECTION_ROUNDS} 轮）；不得再写第 "
            f"{MAX_REFLECTION_ROUNDS + 1} 轮。确认充分后请以 --complete 收敛。"
        )
    else:
        print("NOTE: 不要为凑轮次而机械补写下一轮反思；没有新缺口时应直接 --complete。")


def main():
    """入口：解析参数，从 stdin 读结论，校验并落盘，最后同步进度。"""
    parser = argparse.ArgumentParser(description="Save task or reflection conclusion with validation.")
    parser.add_argument("--type", choices=["task", "reflection"], required=True,
                        help="task = 任务结论, reflection = 阶段 5 反思结论")
    parser.add_argument("--task-id", type=int, help="任务编号（--type task 时必填）")
    parser.add_argument("--round", type=int, help="反思轮次（--type reflection 时必填）")
    parser.add_argument("--force", action="store_true", help="覆盖已有文件（自动备份到 .bak）")
    parser.add_argument(
        "--complete",
        action="store_true",
        help="仅 --type reflection：显式声明研究已充分收敛，冻结报告输入并进入报告阶段。"
             "不带此参数时反思结论正常保存但研究保持 OPEN。",
    )
    parser.add_argument(
        "--output-dir",
        default=None,
        help=f"输出根目录绝对路径（默认基于脚本位置与 app-<id> 目录自动推断：{DEFAULT_OUTPUT_DIR}）",
    )
    args = parser.parse_args()

    if args.type == "task" and args.task_id is None:
        die("--type=task 时必须指定 --task-id")
    if args.type == "reflection" and args.round is None:
        die("--type=reflection 时必须指定 --round")

    # 反思轮次上限：v35 最多 2 轮，且第 2 轮必须建立在第 1 轮之后
    if args.type == "reflection":
        if args.round < 1:
            die("--round 必须 >= 1")
        if args.round > MAX_REFLECTION_ROUNDS:
            die(
                f"反思最多 {MAX_REFLECTION_ROUNDS} 轮，不允许第 {args.round} 轮。"
                f"若研究已充分，请对第 {MAX_REFLECTION_ROUNDS} 轮加 --complete 收敛进入报告阶段。"
            )

    # 解析 output-dir 为绝对路径（进度门也依赖它，提前解析）
    args.output_dir, probed = resolve_output_dir(args.output_dir)

    if args.type == "reflection" and args.round == 2:
        if not tp.is_validated_artifact(args.output_dir, "reflection/round_1.md"):
            die(
                "第 2 轮反思必须建立在第 1 轮 validated 结论之上，但 reflection/round_1.md "
                "不存在，或不是 save_conclusion 认证过的 validated artifact（可能被直写 / 改动）。"
                "请先以正常 save_conclusion 保存并通过校验的第 1 轮反思。"
            )

    # 冻结门（§四）：Stage6 之后研究阶段已关闭，不再接受新的 task/reflection 结论。
    _sr = load_save_report(args.output_dir)
    if report_inputs_frozen(_sr):
        if args.type == "reflection" and args.complete:
            # 幂等：重复 --complete 只重新播报 Stage6 handoff，不改动任何来源文件。
            snapshot = _sr.load_state().get("source_snapshot")
            emit_stage6_handoff(_sr, args.output_dir, snapshot)
            return
        print("REPORT_INPUT_FROZEN: yes", file=sys.stderr)
        print("RESEARCH_STATUS: CLOSED", file=sys.stderr)
        print(
            "ERROR: 报告输入已在 Stage6 冻结，研究阶段已关闭；不再接受新的 task/reflection 结论。"
            "如需修改报告内容，请使用 save_report.py --write / --patch。",
            file=sys.stderr,
        )
        print("INTERACTION_RULE: NO_ASK_USER", file=sys.stderr)
        sys.exit(1)

    # 结论内容读取。reflection --complete 支持「转换调用」：无 stdin 时，若
    # round_N.md 已存在且合法，则读取现有内容做校验/预检/冻结，不修改文件、
    # 不需要 --force。
    is_transition_only = False
    if args.type == "reflection" and args.complete:
        stdin_text = read_stdin_optional()
        if stdin_text is None:
            _existing = os.path.join(
                args.output_dir, "reflection", f"round_{args.round}.md"
            )
            if not os.path.isfile(_existing):
                die(
                    f"未提供 stdin，且不存在 reflection/round_{args.round}.md，无法收敛。"
                    "请先保存该轮反思结论，或在本次调用通过 stdin 传入反思正文。"
                )
            # P0-2：转换调用只能建立在 validated 反思之上。未认证 / 被改动的 round 文件
            # 不能仅凭 --complete 冻结进入报告阶段。
            if not tp.is_validated_artifact(
                args.output_dir, f"reflection/round_{args.round}.md"
            ):
                die(
                    f"reflection/round_{args.round}.md 不是 save_conclusion 认证过的 validated "
                    "artifact（不存在 / 被直写 / 已被改动，SHA 不符）；不能仅凭 --complete 冻结进入报告阶段。"
                    "请先以正常 save_conclusion（stdin 传入正文，不加 --force）保存并通过校验的该轮反思，"
                    "或在本次调用直接通过 stdin 传入反思正文。"
                )
            content = Path(_existing).read_text(encoding="utf-8").strip()
            if not content:
                die(f"reflection/round_{args.round}.md 内容为空，无法收敛。")
            is_transition_only = True
        else:
            content = stdin_text
    else:
        content = read_stdin()

    validate(
        content=content,
        conclusion_type=args.type,
        task_id=args.task_id,
        round_id=args.round,
    )

    # 进度硬门：task 必须等于指针（或该号已有结论，允许覆盖修订）；reflection 必须任务结论已全部齐
    is_amend = False
    if args.type == "task":
        is_amend = tp.validate_save_task(args.output_dir, args.task_id, probed)
    else:
        tp.validate_save_reflection(args.output_dir, probed)

    target_dir, target, label = resolve_target(args)
    os.makedirs(target_dir, exist_ok=True)

    if is_transition_only:
        # 转换调用：不改动现有文件，仅确认进入收敛。
        print(f"OK: 已读取现有 {label} 进入 Stage6 收敛（未修改文件）")
    else:
        rel_path = ("conclusions/task_%d.md" % args.task_id) if args.type == "task" \
            else ("reflection/round_%d.md" % args.round)
        exists = os.path.exists(target)
        already_validated = tp.is_validated_artifact(args.output_dir, rel_path) if exists else False
        if exists:
            if already_validated:
                # 合法修订：目标已是 hash 匹配的 validated artifact，覆盖需 --force。
                if not args.force:
                    die(
                        f"{label} 已是 save_conclusion 认证过的 validated 结论；"
                        "如需覆盖修订，请加 --force（会自动备份 .bak）。"
                    )
                shutil.copy2(target, target + ".bak")
            else:
                # 未受管理（编辑器直写 / 手写 / 被改动导致 SHA 不符）。
                if args.force:
                    die(
                        "该文件不是 save_conclusion 管理的 validated artifact，不能使用 --force 将其合法化。"
                        "请去掉 --force，以正常 save_conclusion 调用重新验证并接管该文件。"
                    )
                # 收编/修复：本次 stdin 已通过 validate，正常调用（无 --force）即可接管：
                # 备份旧文件 → 用 validated 内容覆盖 → 建立正确 provenance。
                shutil.copy2(target, target + ".bak")
                print(f"NOTE: 接管未受管理的 {label}（原文件已备份为 {os.path.basename(target)}.bak）。")

        # P0-1: 落盘前把结论引用的本地抓取缓存映射回来源 URL，使其进入来源快照。
        content_to_write = augment_with_resolved_sources(content, args.output_dir)
        with open(target, "w", encoding="utf-8") as f:
            f.write(content_to_write)

        # P0-2: provenance——对实际落盘内容求 SHA-256 并原子写入 conclusion_state.json。
        # 正式文件写成功但 state 写失败 → 不算 completed，fail closed，下次正常调用可恢复。
        try:
            tp.record_validated_artifact(args.output_dir, rel_path)
        except OSError as exc:
            die(
                f"结论正文已写入 {target}，但 provenance 状态写入失败（{exc}）；本次保存未确认完成"
                "（fail closed）。请重新以正常 save_conclusion 调用完成认证。"
            )

        wc = count_words(content)
        if is_amend:
            print(f"OK: 已覆盖修订 {label}（约 {wc} 字，绝对路径 {target}）")
        else:
            print(f"OK: 已保存 {label}（约 {wc} 字，绝对路径 {target}）")

    if args.type == "reflection":
        if args.complete:
            # Case B: freeze report inputs FIRST; only emit STAGE6_READY on success.
            if _sr is None:
                print(
                    "ERROR: 无法加载 save_report.py，无法冻结报告输入；未进入报告阶段。",
                    file=sys.stderr,
                )
                sys.exit(1)
            # P0-2: Stage6 来源就绪预检，必须在冻结之前；不就绪则不冻结、研究保持 OPEN。
            try:
                _preflight = _sr.stage6_source_preflight_problems()
            except Exception as exc:
                _preflight = [f"来源就绪预检执行失败：{exc}"]
            if _preflight:
                print("STAGE6_SOURCE_PREFLIGHT_FAILED", file=sys.stderr)
                print("RESEARCH_STATUS: OPEN", file=sys.stderr)
                print("REPORT_INPUTS_FROZEN: no", file=sys.stderr)
                for i, problem in enumerate(_preflight, 1):
                    print(f"  {i}. {problem}", file=sys.stderr)
                print(
                    "NEXT: 反思结论已保存，但部分来源无法进入报告来源白名单；"
                    "请在 reflection 阶段重新 fetch_webpage.py 抓取缺失来源"
                    "（或改用带 URL 的网页依据），然后再次以 --complete 调用收敛。"
                    "脚本未冻结报告输入，研究阶段保持开启。",
                    file=sys.stderr,
                )
                print("INTERACTION_RULE: NO_ASK_USER", file=sys.stderr)
                sys.exit(1)
            try:
                snapshot = _sr.freeze_report_inputs_at_stage6()
            except Exception as exc:
                # Fail-safe: NEVER print STAGE6_READY if the snapshot could not be built.
                print("WORKFLOW_STATE: REFLECTION_CONTINUE", file=sys.stderr)
                print("RESEARCH_STATUS: OPEN", file=sys.stderr)
                print(
                    f"ERROR: 冻结报告输入失败（{exc}）；报告阶段未开启。"
                    "请修正报告素材后重新以 --complete 调用。",
                    file=sys.stderr,
                )
                sys.exit(1)
            emit_stage6_handoff(_sr, args.output_dir, snapshot)
        else:
            # Case A: reflection saved, but research stays OPEN (Agent decides sufficiency).
            emit_reflection_continue(args.round)

    # 按磁盘上的 conclusions/task_N.md 重新同步 研究任务.json，并报告完成/待写进度
    if args.type == "task":
        plan_data = tp.load_plan(args.output_dir)
        if plan_data is not None:
            steps, completed_ids, pointer = tp.sync_plan_status(args.output_dir, plan_data)
            k = tp.max_step_num(steps)
            print(f"OK: 研究任务.json 已更新（task-{args.task_id} → completed，{len(completed_ids)}/{k}）")
            if is_amend:
                print(f"NOTE: 本次是修订已完成的 task-{args.task_id}，指针未变。")
            if pointer is None:
                _next_round = next_reflection_round(args.output_dir)
                print(f"完成进度：{len(completed_ids)}/{k}")
                print("WORKFLOW_STATE: TASKS_COMPLETE")
                print("NEXT_STAGE: REFLECTION")
                print(f"REFLECTION_ROUND: {_next_round}")
                print(
                    "HOW: baidu_search.py --phase reflection → "
                    f"save_conclusion.py --type reflection --round {_next_round}"
                )
                print("REFLECTION_SCHEMA:")
                for _line in reflection_schema_lines(_next_round):
                    print(f"  {_line}")
                print(
                    "NOTE: 标题与三个必填段落标签必须逐字一致；段落内容由你（Agent）填写，"
                    "Code 不代写反思内容。"
                )
                print("INTERACTION_RULE: NO_ASK_USER")
                print("FINAL_REPORT_READY: no")
            else:
                print(f"完成进度：{len(completed_ids)}/{k}")
                print("WORKFLOW_STATE: RESEARCH_IN_PROGRESS")
                print(f"NEXT_TASK: task-{pointer}「{tp.step_title(steps, pointer)}」")
                print("INTERACTION_RULE: NO_ASK_USER")
                print("FINAL_REPORT_READY: no")


if __name__ == "__main__":
    main()
