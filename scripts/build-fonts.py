#!/usr/bin/env python3
"""品牌字体子集化：ResourceHanRoundedCN 三字重 TTF -> 本地 woff2 子集（两级分片）。

============================= 字集策略（必读） =============================
原始字体每个约 14MB（全量 CJK 未子集化，三份共 42MB）。全部内联不现实，
单份全 GB2312 子集也有 ~1.15MB × 3 字重 = 3.45MB，弱网首屏仍然是明显负担。
因此这里把每个字重拆成 **两级分片**，配合 CSS `unicode-range` 做按需加载：

  1) core 片（首屏必载，~350KB/字重，三份合计 ~1.05MB）
     = ASCII 可打印字符
     + 中英标点 / 全角字符 / 常用符号（℃ € ① → 制表符 …）
     + 源码（src/**、index.html）里实际出现的所有字符  ← 静态 UI 文案 100% 覆盖
     + 本仓库中文语料按字频排序的 Top-N 个汉字        ← 动态内容（病历/药品/AI 文案）的通用覆盖
     语料来源固定为：src/、docs/、tasks/、根目录 *.md（排除 node_modules/.git/public/dist/.skills
     以及本脚本自己产出的 tasks/fonts/charset*.txt），保证同一份仓库跑出来的字集一致。

  2) rare 片（按需加载，出现罕用字时才下载，约 0.7MB/字重）
     = GB2312 全部汉字 + GB2312 非汉字符号区 − core
     覆盖「曦、懿」这类 GB2312 内但不在高频区的字，不会变成豆腐块。

  3) CDN 全量 ttf（兜底，core/rare 都不覆盖时才回源）
     与 core/rare 一起声明在同一个 font-family 下，见 src/index.css。

CSS 侧依赖「同一 family 下后声明的 @font-face 胜出」（已在 Edge/Chromium 实测），
因此声明顺序固定为：CDN 兜底 -> rare（粗粒度 CJK 块）-> core（精确 unicode-range）。
这样 rare 的 unicode-range 只需十几个块级区间，而 core 需要精确到字（约 1.4k 个区间）。

用法：
    python scripts/build-fonts.py
产物：
    public/fonts/ResourceHanRoundedCN-{Regular,Medium,Heavy}.core.woff2
    public/fonts/ResourceHanRoundedCN-{Regular,Medium,Heavy}.rare.woff2
    tasks/fonts/charset-core.txt / charset-rare.txt      （字集快照，便于 review）
    tasks/fonts/unicode-range-core.txt / -rare.txt       （供 src/index.css 粘贴）
"""

from __future__ import annotations

import collections
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
RAW_DIR = ROOT / "tasks" / "fonts" / "raw"
OUT_DIR = ROOT / "public" / "fonts"
CHARSET_FILE = ROOT / "tasks" / "fonts" / "charset.txt"

WEIGHTS = ["Regular", "Medium", "Heavy"]

# core 片里除 ASCII/标点/源码字符外，额外纳入的汉字数量（按仓库语料字频取 Top-N）。
# 2000 是实测出来的平衡点：三份 core 合计 ~1.05MB，首屏预算 1.2MB 留约 12% 余量。
COMMON_HANZI_TOP_N = 2000

# GB2312 双字节区：0xB0A1 - 0xF7FE（一级 + 二级汉字，约 6763 字）
GB2312_HANZI_RANGE = (range(0xB0, 0xF8), range(0xA1, 0xFF))
# GB2312 非汉字符号区：0xA1A1 - 0xA9FE（标点、希腊字母、假名、制表符等）
GB2312_SYMBOL_RANGE = (range(0xA1, 0xAA), range(0xA1, 0xFF))

# 补充：GB2312 之外的常用字符（引号、破折号、省略号、温度符号、商标等）
EXTRA_CHARS = (
    "‘’“”–—…·′″‹›«»℃℉€£¥©®™°±×÷≤≥≠∞←→↑↓"
    "①②③④⑤⑥⑦⑧⑨⑩⓪"
    "─│┌┐└┘├┤┬┴┼"
    "\u3000\u00a0"
)

SOURCE_GLOBS = ("src/**/*.ts", "src/**/*.tsx", "src/**/*.css", "index.html")

# 语料目录：用于统计汉字字频（决定哪些字进 core 片）
CORPUS_DIRS = ("src", "docs", "tasks")
CORPUS_SUFFIXES = {".ts", ".tsx", ".md", ".html", ".css", ".json", ".txt", ".js", ".py", ".sql"}
CORPUS_SKIP_DIRS = {"node_modules", ".git", "public", "dist", ".venv", ".skills", "raw"}
# 本脚本自己产出的字集快照不能当语料，否则会成为自我实现的预言
CORPUS_SKIP_FILES = {"charset.txt", "charset-core.txt", "charset-rare.txt"}

# rare 片 unicode-range 用「块级粗区间」表达（core 片声明在后面会覆盖掉其中的常用字），
# 避免为 4800 个零散码点生成几千个区间把 CSS 撑爆。
COARSE_BLOCKS = [
    (0x00A0, 0x00FF),
    (0x0100, 0x017F),
    (0x0370, 0x03FF),
    (0x2000, 0x206F),
    (0x2100, 0x214F),
    (0x2150, 0x218F),
    (0x2190, 0x21FF),
    (0x2200, 0x22FF),
    (0x2460, 0x24FF),
    (0x2500, 0x257F),
    (0x25A0, 0x25FF),
    (0x2600, 0x26FF),
    (0x3000, 0x303F),
    (0x3040, 0x309F),
    (0x30A0, 0x30FF),
    (0x3100, 0x312F),
    (0x3190, 0x319F),
    (0x3200, 0x32FF),
    (0x3300, 0x33FF),
    (0x4E00, 0x9FFF),
    (0xFE10, 0xFE4F),
    (0xFF00, 0xFFEF),
]

CJK = ("一", "鿿")


def decode_range(high: range, low: range) -> set[str]:
    chars: set[str] = set()
    for b1 in high:
        for b2 in low:
            try:
                chars.add(bytes([b1, b2]).decode("gb2312"))
            except UnicodeDecodeError:
                continue
    return chars


def collect_source_chars() -> set[str]:
    chars: set[str] = set()
    for pattern in SOURCE_GLOBS:
        for path in ROOT.glob(pattern):
            if not path.is_file():
                continue
            try:
                chars.update(path.read_text(encoding="utf-8"))
            except (OSError, UnicodeDecodeError):
                continue
    return chars


def corpus_hanzi_by_freq() -> list[str]:
    """统计仓库中文语料的汉字字频，返回按频次降序、同频按码点升序的汉字列表。"""
    counter: collections.Counter[str] = collections.Counter()
    for base in CORPUS_DIRS:
        root = ROOT / base
        if not root.is_dir():
            continue
        for path in root.rglob("*"):
            if not path.is_file() or path.suffix.lower() not in CORPUS_SUFFIXES:
                continue
            if path.name in CORPUS_SKIP_FILES:
                continue
            if any(part in CORPUS_SKIP_DIRS for part in path.relative_to(ROOT).parts):
                continue
            try:
                text = path.read_text(encoding="utf-8")
            except (OSError, UnicodeDecodeError):
                continue
            counter.update(c for c in text if CJK[0] <= c <= CJK[1])
    for path in ROOT.glob("*.md"):
        if not path.is_file():
            continue
        try:
            counter.update(c for c in path.read_text(encoding="utf-8") if CJK[0] <= c <= CJK[1])
        except (OSError, UnicodeDecodeError):
            continue
    return [c for c, _ in sorted(counter.items(), key=lambda kv: (-kv[1], kv[0]))]


def printable(chars: set[str]) -> set[str]:
    return {c for c in chars if c.isprintable() or c in "\n\t\r"}


def base_chars() -> set[str]:
    """core/rare 都带的基础字符：ASCII + 中英标点 + 全角 + 常用符号。"""
    chars: set[str] = set()
    chars.update(chr(c) for c in range(0x20, 0x7F))
    chars.update(chr(c) for c in range(0x3000, 0x3040))
    chars.update(chr(c) for c in range(0xFF00, 0xFFF0))
    chars.update(EXTRA_CHARS)
    return chars


def build_charsets() -> tuple[set[str], set[str]]:
    src = printable(collect_source_chars())
    base = printable(base_chars())
    gb = printable(decode_range(*GB2312_HANZI_RANGE) | decode_range(*GB2312_SYMBOL_RANGE))

    top = corpus_hanzi_by_freq()[:COMMON_HANZI_TOP_N]
    core = base | src | set(top)
    # rare 只保留 GB2312 覆盖范围内、core 没吃掉的字（生僻字兜底）
    rare = (gb | src) - core
    return printable(core), printable(rare)


def to_ranges(chars: set[str]) -> list[tuple[int, int]]:
    cps = sorted(ord(c) for c in chars)
    out: list[tuple[int, int]] = []
    start = prev = cps[0]
    for cp in cps[1:]:
        if cp == prev + 1:
            prev = cp
        else:
            out.append((start, prev))
            start = prev = cp
    out.append((start, prev))
    return out


def fmt_ranges(ranges: list[tuple[int, int]]) -> str:
    return ",".join(
        f"U+{a:04X}" if a == b else f"U+{a:04X}-{b:04X}" for a, b in ranges
    )


def coarse_ranges(chars: set[str]) -> str:
    blocks = [b for b in COARSE_BLOCKS if any(b[0] <= ord(c) <= b[1] for c in chars)]
    return fmt_ranges(blocks)


def subset(name: str, tier: str, charset: set[str]) -> pathlib.Path:
    src = RAW_DIR / f"ResourceHanRoundedCN-{name}.ttf"
    dst = OUT_DIR / f"ResourceHanRoundedCN-{name}.{tier}.woff2"
    if not src.is_file():
        raise SystemExit(f"[缺失] 原始字体不存在：{src}")

    text_file = ROOT / "tasks" / "fonts" / f".build-{tier}.txt"
    text_file.write_text("".join(sorted(charset)), encoding="utf-8")

    cmd = [
        sys.executable,
        "-m",
        "fontTools.subset",
        str(src),
        f"--text-file={text_file}",
        "--flavor=woff2",
        "--layout-features=*",
        "--no-hinting",
        "--desubroutinize",
        "--name-IDs=0,1,2,3,4,5,6",
        "--output-file=" + str(dst),
    ]
    subprocess.run(cmd, check=True)
    text_file.unlink(missing_ok=True)
    return dst


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    (ROOT / "tasks" / "fonts").mkdir(parents=True, exist_ok=True)

    core, rare = build_charsets()
    (ROOT / "tasks" / "fonts" / "charset-core.txt").write_text(
        "".join(sorted(core)), encoding="utf-8"
    )
    (ROOT / "tasks" / "fonts" / "charset-rare.txt").write_text(
        "".join(sorted(rare)), encoding="utf-8"
    )
    CHARSET_FILE.write_text("".join(sorted(core | rare)), encoding="utf-8")

    core_ur = fmt_ranges(to_ranges(core))
    rare_ur = coarse_ranges(rare)
    (ROOT / "tasks" / "fonts" / "unicode-range-core.txt").write_text(core_ur, encoding="utf-8")
    (ROOT / "tasks" / "fonts" / "unicode-range-rare.txt").write_text(rare_ur, encoding="utf-8")

    hanzi = lambda s: sum(1 for c in s if CJK[0] <= c <= CJK[1])  # noqa: E731
    print(f"core 字集: {len(core)} 字符（汉字 {hanzi(core)}）-> core.woff2")
    print(f"rare 字集: {len(rare)} 字符（汉字 {hanzi(rare)}）-> rare.woff2")
    print(f"unicode-range: core {len(core_ur)} 字节 / rare {len(rare_ur)} 字节")

    total_core = 0
    for name in WEIGHTS:
        sizes = {}
        for tier, charset in (("core", core), ("rare", rare)):
            dst = subset(name, tier, charset)
            sizes[tier] = dst.stat().st_size
        total_core += sizes["core"]
        print(
            f"  {name:<8} core {sizes['core'] / 1024:7.1f} KB   "
            f"rare {sizes['rare'] / 1024:7.1f} KB"
        )
    print(
        f"首屏必载（三字重 core 合计）: {total_core / 1024 / 1024:.3f} MB  "
        f"[预算 1.200 MB]"
    )
    if total_core > 1_200_000:
        print("[警告] core 片超出首屏预算，请调小 COMMON_HANZI_TOP_N", file=sys.stderr)


if __name__ == "__main__":
    main()
