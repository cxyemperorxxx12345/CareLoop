#!/usr/bin/env python3
"""从 JSON 配置生成静态 PNG 图表，供嵌入 docx 研究报告。

用法：
    python make_chart.py --spec chart_spec.json

配置格式（JSON 文件）：
{
  "type": "bar | hbar | grouped_bar | stacked_bar | line | pie | scatter",
  "title": "标题（写结论而非数据名，如“开源框架 Star 数差距悬殊”）",
  "x": ["类别1", "类别2", ...],                 # 分类标签 / x 轴值
  "series": [{"name": "系列名", "data": [1, 2, 3]}],  # 一个或多个系列
  "xlabel": "x 轴标题（可选）",
  "ylabel": "y 轴标题（可选）",
  "source": "数据来源与时间范围（可选，作为图注）",
  "output": "outputs/chart_1.png"
}

说明：
- pie：用 series[0].data 作为数值，x 作为各扇区标签（类别数建议 2–6）
- scatter：x 为横坐标值，series[0].data 为纵坐标值
- grouped_bar / stacked_bar：多个 series，共享同一组 x 分类
"""

import argparse
import json
import re
import sys
from pathlib import Path

from save_report import detect_report_language


CJK_RE = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff]")


def visible_spec_text(spec):
    """Collect only labels that will be visible in the rendered chart."""
    rows = []
    for key in ("title", "xlabel", "ylabel", "source"):
        value = spec.get(key)
        if value:
            rows.append((key, str(value)))
    for index, value in enumerate(spec.get("x") or []):
        if isinstance(value, str):
            rows.append((f"x[{index}]", value))
    for index, item in enumerate(spec.get("series") or []):
        if isinstance(item, dict) and item.get("name"):
            rows.append((f"series[{index}].name", str(item["name"])))
    return rows


def numeric_values(spec):
    """Yield all numeric data points across the spec's series."""
    for item in spec.get("series") or []:
        if not isinstance(item, dict):
            continue
        for value in item.get("data") or []:
            if isinstance(value, (int, float)) and not isinstance(value, bool):
                yield float(value)


def validate_visible_language(spec, language):
    """Check visible chart text matches the report language and flags magnitude/sign mismatches."""
    rows = visible_spec_text(spec)
    combined = " ".join(value for _, value in rows)
    problems = []
    if language == "en-US":
        mixed = [name for name, value in rows if CJK_RE.search(value)]
        if mixed:
            problems.append("报告语言为 English，但以下图表可见字段含中文：" + "、".join(mixed))
    else:
        cjk = len(CJK_RE.findall(combined))
        latin = len(re.findall(r"[A-Za-z]", combined))
        if cjk == 0 and latin >= 30:
            problems.append("报告语言为中文，但图表标题、坐标轴和图注整体为英文。")

    normalized = combined.lower()
    magnitude_label = any(token in normalized for token in ("绝对值", "绝对量", "absolute value", "magnitude"))
    if magnitude_label and any(value < 0 for value in numeric_values(spec)):
        problems.append("图表标签声明为绝对值/幅度，但数据仍含负数；请统一语义与数值方向。")
    return problems


def setup_cjk_font():
    """设置中文字体，避免中文乱码。按常见字体依次尝试。"""
    import matplotlib
    from matplotlib import font_manager

    candidates = [
        "Microsoft YaHei", "SimHei", "PingFang SC", "Heiti SC",
        "Noto Sans CJK SC", "Source Han Sans SC", "WenQuanYi Zen Hei",
        "Arial Unicode MS",
    ]
    available = {f.name for f in font_manager.fontManager.ttflist}
    for name in candidates:
        if name in available:
            matplotlib.rcParams["font.sans-serif"] = [name]
            break
    matplotlib.rcParams["axes.unicode_minus"] = False


def main():
    """入口：读取配置，按类型绘图并输出 PNG。"""
    parser = argparse.ArgumentParser(description="Generate a PNG chart from a JSON spec.")
    parser.add_argument("--spec", required=True, help="图表配置 JSON 文件路径")
    args = parser.parse_args()

    try:
        spec = json.loads(Path(args.spec).read_text(encoding="utf-8-sig"))
    except Exception as exc:
        print(f"读取配置失败：{exc}", file=sys.stderr)
        sys.exit(1)

    language = detect_report_language()
    language_problems = validate_visible_language(spec, language)
    if language_problems:
        print(f"图表校验未通过（{len(language_problems)}）：", file=sys.stderr)
        for index, problem in enumerate(language_problems, 1):
            print(f"  {index}. {problem}", file=sys.stderr)
        sys.exit(2)

    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
    except ImportError:
        print("运行环境缺少预置 matplotlib，无法生成图表；不要临时安装依赖。", file=sys.stderr)
        sys.exit(1)

    setup_cjk_font()

    ctype = spec.get("type", "bar")
    title = spec.get("title", "")
    x = spec.get("x", [])
    series = spec.get("series", [])
    output = spec.get("output")

    if not output:
        print("配置缺少 output 字段", file=sys.stderr)
        sys.exit(1)
    if ctype != "pie" and not series:
        print("配置缺少 series 数据", file=sys.stderr)
        sys.exit(1)

    Path(output).parent.mkdir(parents=True, exist_ok=True)

    palette = ["#4C78A8", "#F58518", "#54A24B", "#E45756", "#72B7B2", "#EECA3B"]
    default_series = "Series" if language == "en-US" else "系列"
    fig, ax = plt.subplots(figsize=(8, 5), dpi=150)

    if ctype == "bar":
        ax.bar(x, series[0]["data"], color=palette[0])
    elif ctype == "hbar":
        ax.barh(x, series[0]["data"], color=palette[0])
        ax.invert_yaxis()
    elif ctype == "grouped_bar":
        import numpy as np
        n = len(series)
        width = 0.8 / n
        idx = np.arange(len(x))
        for i, s in enumerate(series):
            ax.bar(idx + i * width, s["data"], width, label=s.get("name", f"{default_series} {i+1}"),
                   color=palette[i % len(palette)])
        ax.set_xticks(idx + width * (n - 1) / 2)
        ax.set_xticklabels(x)
        ax.legend()
    elif ctype == "stacked_bar":
        import numpy as np
        bottom = np.zeros(len(x))
        for i, s in enumerate(series):
            data = np.array(s["data"], dtype=float)
            ax.bar(x, data, bottom=bottom, label=s.get("name", f"{default_series} {i+1}"),
                   color=palette[i % len(palette)])
            bottom += data
        ax.legend()
    elif ctype == "line":
        for i, s in enumerate(series):
            ax.plot(x, s["data"], marker="o", label=s.get("name", f"{default_series} {i+1}"),
                    color=palette[i % len(palette)])
        if len(series) > 1:
            ax.legend()
    elif ctype == "pie":
        data = (series[0]["data"] if series else spec.get("data", []))
        ax.pie(data, labels=x, autopct="%1.1f%%", startangle=90,
               colors=palette[:len(x)])
        ax.axis("equal")
    elif ctype == "scatter":
        for i, s in enumerate(series):
            ax.scatter(x, s["data"], label=s.get("name", f"{default_series} {i+1}"),
                       color=palette[i % len(palette)])
        if len(series) > 1:
            ax.legend()
    else:
        print(f"未知图表类型：{ctype}", file=sys.stderr)
        sys.exit(1)

    if title:
        ax.set_title(title, fontsize=13, fontweight="bold")
    if ctype not in ("pie",):
        if spec.get("xlabel"):
            ax.set_xlabel(spec["xlabel"])
        if spec.get("ylabel"):
            ax.set_ylabel(spec["ylabel"])

    # 分类多或标签长时旋转 x 轴标签，避免重叠
    if ctype in ("bar", "grouped_bar", "stacked_bar", "line") and x:
        max_len = max((len(str(v)) for v in x), default=0)
        if len(x) > 6 or max_len > 6:
            plt.setp(ax.get_xticklabels(), rotation=30, ha="right")

    if spec.get("source"):
        source_prefix = "Source: " if language == "en-US" else "来源："
        fig.text(0.99, 0.01, source_prefix + str(spec["source"]),
                 ha="right", va="bottom", fontsize=8, color="#666666")

    fig.tight_layout()
    fig.savefig(output, bbox_inches="tight")
    print(json.dumps(
        {"status": "succeed", "output": output, "language": language},
        ensure_ascii=False,
    ))


if __name__ == "__main__":
    main()
