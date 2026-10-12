#!/usr/bin/env python3
"""品牌字体子集化：ResourceHanRoundedCN 三字重 TTF -> 本地 woff2 子集。

原始字体每个约 14MB（全量 CJK 未子集化，三份共 42MB），演示环境断网/弱网时
`font-display: swap` 会让排版先塌成系统字体。这里按「GB2312 全部汉字 + ASCII +
中英标点 + 源码实际字符」取子集，把每份压到 1~2MB 内，随仓库一起部署。

用法：
    python scripts/build-fonts.py
产物：
    public/fonts/ResourceHanRoundedCN-{Regular,Medium,Heavy}.subset.woff2
"""

from __future__ import annotations

import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
RAW_DIR = ROOT / "tasks" / "fonts" / "raw"
OUT_DIR = ROOT / "public" / "fonts"
CHARSET_FILE = ROOT / "tasks" / "fonts" / "charset.txt"

WEIGHTS = ["Regular", "Medium", "Heavy"]

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


def build_charset() -> str:
    chars: set[str] = set()

    # 1. ASCII 可打印字符
    chars.update(chr(c) for c in range(0x20, 0x7F))

    # 2. GB2312 汉字 + 符号区
    chars |= decode_range(*GB2312_HANZI_RANGE)
    chars |= decode_range(*GB2312_SYMBOL_RANGE)

    # 3. 中文标点 / 全角字符
    chars.update(chr(c) for c in range(0x3000, 0x3040))
    chars.update(chr(c) for c in range(0xFF00, 0xFFF0))

    # 4. 补充字符
    chars.update(EXTRA_CHARS)

    # 5. 源码里实际出现的字符（兜底，防止 GB2312 覆盖不到的生僻字/特殊符号）
    chars |= collect_source_chars()

    # 控制字符与换行不进字体
    chars = {c for c in chars if c.isprintable() or c in "\n\t\r"}

    return "".join(sorted(chars))


def subset(name: str, charset_file: pathlib.Path) -> pathlib.Path:
    src = RAW_DIR / f"ResourceHanRoundedCN-{name}.ttf"
    dst = OUT_DIR / f"ResourceHanRoundedCN-{name}.subset.woff2"
    if not src.is_file():
        raise SystemExit(f"[缺失] 原始字体不存在：{src}")

    cmd = [
        sys.executable,
        "-m",
        "fontTools.subset",
        str(src),
        f"--text-file={charset_file}",
        "--flavor=woff2",
        "--layout-features=*",
        "--no-hinting",
        "--desubroutinize",
        "--name-IDs=0,1,2,3,4,5,6",
        "--output-file=" + str(dst),
    ]
    print(f"  > subset {name} ...")
    subprocess.run(cmd, check=True)
    return dst


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    charset = build_charset()
    CHARSET_FILE.write_text(charset, encoding="utf-8")
    print(f"charset: {len(charset)} chars -> {CHARSET_FILE.relative_to(ROOT)}")

    for name in WEIGHTS:
        dst = subset(name, CHARSET_FILE)
        size = dst.stat().st_size
        print(f"  {dst.name}: {size / 1024 / 1024:.2f} MB ({size} bytes)")


if __name__ == "__main__":
    main()
