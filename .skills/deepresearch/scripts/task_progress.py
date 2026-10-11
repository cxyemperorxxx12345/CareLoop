#!/usr/bin/env python3
"""Shared 研究任务.json / conclusions 进度门，供 baidu_search.py、fetch_webpage.py、
save_conclusion.py 三个脚本共用。

核心概念：
- 「完成」只认经 save_conclusion.py 认证过的 validated artifact：conclusions/task_N.md
  同时满足 (1) 文件存在、(2) 在 outputs/research/conclusion_state.json 有 provenance 记录、
  (3) 当前文件 SHA-256 与记录一致。编辑器直写 / 手写 / 被改动（SHA 不符）都不算完成。
- 「待写」= 指针 = 按编号顺序第一个还不是 validated 的任务号；全部 validated 时指针为 None。
- search / fetch 的 --phase task-N 只允许在 N-1 已有过 search/fetch 记录或 task_{N-1}.md
  已是 validated artifact 时才放行（不跳号）；--phase reflection 只允许在指针为 None（任务结论
  全部 validated）时放行。
- save_conclusion.py --type task 要求 --task-id 必须等于指针；--type reflection 要求
  指针为 None。

outputs/ 目录定位（resolve_output_dir）：
- 命令行 --output-dir 优先；否则在候选项目根里挑第一个已存在 研究任务.json 的，
  避免「阶段 3 写文件」和「阶段 4 读文件」因为根目录推断不一致而错开。
- sandbox 里 app 根是 /workspace/app-<id>，而 bash 的 cwd 常是 /workspace，
  所以 cwd 只作为最后兜底，优先用脚本自身路径锚定。
"""

import json
import hashlib
import os
import re
import sys
from datetime import datetime, timezone


PLAN_FILENAME = "研究任务.json"
CONCLUSIONS_DIRNAME = "conclusions"
REFLECTION_DIRNAME = "reflection"
RESEARCH_DIRNAME = "research"

# 程序内部 provenance 状态（不是报告来源产物，不进 report source snapshot、不进 deepresearch.zip）：
# outputs/research/conclusion_state.json 记录每个 validated 结论/反思文件的 SHA-256。
CONCLUSION_STATE_FILENAME = "conclusion_state.json"
CONCLUSION_STATE_SCHEMA_VERSION = 1

PHASE_TASK_RE = re.compile(r"^task-(\d+)$")

# sandbox 里 app 根目录形如 /workspace/app-<id>，而 bash 的 cwd 常常是它的父目录
# /workspace。所以不能拿 cwd 当项目根，需要按目录名锚定。
APP_ROOT_RE = re.compile(r"^app-[\w-]+$")


def die(message):
    """打印错误信息（可多行）并以非零状态退出。"""
    print(message, file=sys.stderr)
    sys.exit(1)


def _plan_path(output_dir):
    """拼出 研究任务.json 的完整路径。"""
    return os.path.join(output_dir, PLAN_FILENAME)


def _walk_up_for_app(start):
    """从 start 逐级向上找第一个 app-<id> 目录；找不到返回 None。"""
    probe = os.path.abspath(start)
    while True:
        if APP_ROOT_RE.match(os.path.basename(probe)):
            return probe
        parent = os.path.dirname(probe)
        if parent == probe:
            return None
        probe = parent


def candidate_project_roots(script_path):
    """按优先级列出项目根候选，用于在缺少显式参数时定位 outputs/。

    优先级依据可靠程度排列：
    1. 约定部署路径 <PROJECT_ROOT>/.skills/<skill>/scripts/ 的上 3 级——平台
       标准安装位置，最可靠；
    2. 脚本路径里的 app-<id> 祖先目录——部署层级变化时的兜底；
    3. cwd 的 app-<id> 祖先目录；
    4. cwd 本身——本地调试或 skill 不在 app 内时才会用到。
    cwd 排在最后是因为 sandbox 里 bash 常从 /workspace（app 根的父目录）执行命令。
    """
    script_dir = os.path.dirname(os.path.abspath(script_path))
    roots = [os.path.abspath(os.path.join(script_dir, "..", "..", ".."))]
    for probe in (script_dir, os.getcwd()):
        hit = _walk_up_for_app(probe)
        if hit:
            roots.append(hit)
    roots.append(os.path.abspath(os.getcwd()))

    unique = []
    for root in roots:
        if root not in unique:
            unique.append(root)
    return unique


def resolve_output_dir(script_path, explicit=None):
    """确定 outputs 目录，返回 (output_dir, probed)。

    explicit（命令行 --output-dir）优先；否则在候选项目根中选第一个已存在
    研究任务.json 的，让「阶段 3 写文件」和「阶段 4 读文件」不会因为根目录推断
    不一致而错开。全都没有时返回首个候选，probed 带上查找过的绝对路径，供报错
    时直接告诉调用方该把文件写到哪里。
    """
    if explicit:
        return os.path.abspath(explicit), []

    roots = candidate_project_roots(script_path)
    probed = []
    for root in roots:
        output_dir = os.path.join(root, "outputs")
        plan_path = _plan_path(output_dir)
        probed.append(plan_path)
        if os.path.isfile(plan_path):
            return output_dir, probed
    return os.path.join(roots[0], "outputs"), probed


def missing_plan_message(output_dir, probed=None):
    """拼出「找不到 研究任务.json」的报错文案，带上绝对路径便于一次性修好。"""
    lines = [
        f"ERROR: 未找到 {_plan_path(output_dir)}，"
        "阶段 4/5 的搜索与抓取以它为前置条件。"
    ]
    if probed and len(probed) > 1:
        lines.append("已查找过以下位置，均不存在：")
        lines.extend(f"  - {p}" for p in probed)
    lines.append(
        f"请回到阶段 3 把研究任务写到 {_plan_path(output_dir)}（绝对路径），"
        "或用 --output-dir 指向已有 outputs 目录后重试。"
    )
    return "\n".join(lines)


def load_plan(output_dir):
    """读取 研究任务.json；不存在返回 None；存在但解析失败直接 die。"""
    path = _plan_path(output_dir)
    if not os.path.isfile(path):
        return None
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError) as exc:
        die(f"ERROR: 读取 outputs/{PLAN_FILENAME} 失败：{exc}")


def plan_steps(plan_data):
    """取出计划里的 steps 列表；plan_data 为空时返回空列表。"""
    return plan_data.get("plan", {}).get("steps", []) if plan_data else []


def step_num(step):
    """从 step 的 id（如 task-3）里解析出任务编号；解析不到返回 0。"""
    m = re.search(r"\d+", step.get("id", "0"))
    return int(m.group()) if m else 0


def _steps_by_num(steps):
    """把 steps 列表转成 {任务编号: step} 映射，便于按号查找。"""
    return {step_num(s): s for s in steps}


def step_title(steps, n):
    """取任务 N 的标题；找不到该任务时返回空串。"""
    step = _steps_by_num(steps).get(n)
    return step.get("title", "") if step else ""


def max_step_num(steps):
    """返回最大任务编号（即任务总数 k）；无任务时返回 0。"""
    nums = [step_num(s) for s in steps]
    return max(nums) if nums else 0


def _research_dir(output_dir):
    """outputs/research 目录（存放 research_log.json 与 provenance 状态）。"""
    return os.path.join(output_dir, RESEARCH_DIRNAME)


def _conclusion_state_path(output_dir):
    """outputs/research/conclusion_state.json 的完整路径。"""
    return os.path.join(_research_dir(output_dir), CONCLUSION_STATE_FILENAME)


def _artifact_abs_path(output_dir, rel_path):
    """把 provenance 里的相对键（正斜杠）还原成本机绝对路径。"""
    return os.path.join(output_dir, *rel_path.split("/"))


def sha256_text(text):
    """对文本按 UTF-8 编码求 SHA-256（十六进制小写）。"""
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def hash_artifact_file(path):
    """以文本模式读取文件并求 SHA-256，规避 Windows 换行(\\r\\n) 与写入(\\n)不一致。"""
    with open(path, "r", encoding="utf-8") as f:
        return sha256_text(f.read())


def load_conclusion_state(output_dir):
    """读取 conclusion_state.json。

    - 文件缺失 → 返回全新空状态（绝不把磁盘既有 md 自动认证为 completed）。
    - 文件损坏 / 结构非法 → fail closed：die 显式报错，绝不静默重新认证所有磁盘文件。
    """
    path = _conclusion_state_path(output_dir)
    if not os.path.isfile(path):
        return {"schema_version": CONCLUSION_STATE_SCHEMA_VERSION, "artifacts": {}}
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (json.JSONDecodeError, OSError) as exc:
        die(
            f"ERROR: 无法解析 {CONCLUSION_STATE_FILENAME}（{exc}）；provenance 状态损坏，拒绝继续"
            "（fail closed，不自动重新认证磁盘上的结论文件）。请人工修复该文件，或删除后以"
            " save_conclusion.py 重新认证相关结论。"
        )
    if not isinstance(data, dict) or not isinstance(data.get("artifacts"), dict):
        die(
            f"ERROR: {CONCLUSION_STATE_FILENAME} 结构非法（缺少 artifacts 字典）；provenance 状态损坏，"
            "拒绝继续（fail closed）。"
        )
    data.setdefault("schema_version", CONCLUSION_STATE_SCHEMA_VERSION)
    return data


def _atomic_write_json(path, data):
    """原子写 JSON：先写 .tmp 再 os.replace，避免半截文件。"""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    os.replace(tmp, path)


def is_validated_artifact(output_dir, rel_path, state=None):
    """rel_path 是否为 validated artifact：文件存在 + 有记录 + 当前 SHA-256 与记录一致。"""
    if state is None:
        state = load_conclusion_state(output_dir)
    rec = state.get("artifacts", {}).get(rel_path)
    if not isinstance(rec, dict) or not rec.get("sha256"):
        return False
    abs_path = _artifact_abs_path(output_dir, rel_path)
    if not os.path.isfile(abs_path):
        return False
    try:
        return hash_artifact_file(abs_path) == rec["sha256"]
    except OSError:
        return False


def record_validated_artifact(output_dir, rel_path):
    """对磁盘上的 rel_path 求 SHA-256 并原子写入 provenance 状态，返回该 SHA-256。"""
    abs_path = _artifact_abs_path(output_dir, rel_path)
    digest = hash_artifact_file(abs_path)
    state = load_conclusion_state(output_dir)
    state.setdefault("artifacts", {})[rel_path] = {
        "sha256": digest,
        "validated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }
    _atomic_write_json(_conclusion_state_path(output_dir), state)
    return digest


def validated_task_ids(output_dir, state=None):
    """所有 validated 的任务号（conclusions/task_N.md 通过 provenance 校验）。"""
    if state is None:
        state = load_conclusion_state(output_dir)
    ids = set()
    for rel in state.get("artifacts", {}):
        m = re.match(r"conclusions/task_(\d+)\.md$", rel)
        if m and is_validated_artifact(output_dir, rel, state):
            ids.add(int(m.group(1)))
    return ids


def validated_reflection_rounds(output_dir, state=None):
    """所有 validated 的反思轮次（reflection/round_N.md 通过 provenance 校验）。"""
    if state is None:
        state = load_conclusion_state(output_dir)
    rounds = set()
    for rel in state.get("artifacts", {}):
        m = re.match(r"reflection/round_(\d+)\.md$", rel)
        if m and is_validated_artifact(output_dir, rel, state):
            rounds.add(int(m.group(1)))
    return rounds


def completed_ids_from_disk(output_dir):
    """完成 = validated artifact：conclusions/task_N.md 存在 + 有 provenance 记录 +
    当前 SHA-256 与记录一致。仅磁盘存在（编辑器直写 / 手写 / 被改动）不算完成。"""
    return validated_task_ids(output_dir)


def first_missing_id(steps, completed_ids):
    """按编号顺序第一个还没有结论文件的任务号；全部完成返回 None。"""
    for n in sorted(step_num(s) for s in steps):
        if n not in completed_ids:
            return n
    return None


def missing_ids(steps, completed_ids):
    """返回所有还没有结论文件的任务号，升序排列。"""
    return sorted(step_num(s) for s in steps if step_num(s) not in completed_ids)


def sync_plan_status(output_dir, plan_data):
    """按 provenance 校验过的 validated 结论同步 研究任务.json 的 status：

    - validated 的 step（见 completed_ids_from_disk）→ completed；仅磁盘存在但未认证不算。
    - 指针（第一个还不是 validated 的 step）→ in_progress。
    - 其余 → pending（超前搜索只写 log，不把 JSON 标 in_progress）。

    返回 (steps, completed_ids, pointer)；有修改才写回文件。
    """
    steps = plan_steps(plan_data)
    if not steps:
        return steps, set(), None

    completed_ids = completed_ids_from_disk(output_dir)
    pointer = first_missing_id(steps, completed_ids)

    modified = False
    for step in steps:
        n = step_num(step)
        if n in completed_ids:
            if step.get("status") != "completed":
                step["status"] = "completed"
                modified = True
        elif n == pointer:
            if step.get("status") != "in_progress":
                step["status"] = "in_progress"
                modified = True
        else:
            if step.get("status") != "pending":
                step["status"] = "pending"
                modified = True

    if modified:
        plan_data["last_updated_at"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        with open(_plan_path(output_dir), "w", encoding="utf-8") as f:
            json.dump(plan_data, f, ensure_ascii=False, indent=2)

    return steps, completed_ids, pointer


def log_touched_ids(log_data):
    """log 里出现过 phase=task-N 记录的所有 N（search + fetch 合并统计）。"""
    ids = set()
    for entry in log_data.get("search", []) + log_data.get("fetch", []):
        m = PHASE_TASK_RE.match(entry.get("phase", "") or "")
        if m:
            ids.add(int(m.group(1)))
    return ids


def has_prior_evidence(output_dir, log_data, n):
    """N 是否已有 search/fetch 记录，或 conclusions/task_N.md 已是 validated artifact（跳号判定用）。

    仅磁盘存在但未经 save_conclusion 认证的 task_N.md 不能推进后续任务。
    """
    if n in log_touched_ids(log_data):
        return True
    return is_validated_artifact(output_dir, f"{CONCLUSIONS_DIRNAME}/task_{n}.md")


def format_id_list(steps, ids):
    """把任务号集合渲染成 `task-N「标题」、...` 的中文提示串。"""
    parts = [f"task-{n}「{step_title(steps, n)}」" for n in sorted(ids)]
    return "、".join(parts)


def validate_phase_for_research(output_dir, phase, log_data, probed=None):
    """search / fetch 阶段 4/5 硬门：无 JSON / phase 非法 / 越界 / 跳号 / reflection 未齐。

    在真正发起网络请求前调用，避免违规调用浪费配额。
    probed 是 resolve_output_dir 查找过的路径，仅用于把报错说清楚。
    返回 (steps, completed_ids) 供后续渲染进度块复用。
    """
    plan_data = load_plan(output_dir)
    if plan_data is None:
        die(missing_plan_message(output_dir, probed))

    steps, completed_ids, pointer = sync_plan_status(output_dir, plan_data)
    k = max_step_num(steps)

    if phase == "reflection":
        missing = missing_ids(steps, completed_ids)
        if missing:
            die(
                "ERROR: 不能进入反思：任务结论未齐（"
                f"{len(completed_ids)}/{k}）。缺 {format_id_list(steps, missing)}。"
            )
        return steps, completed_ids

    m = PHASE_TASK_RE.match(phase or "")
    if not m:
        die(f"ERROR: --phase 非法（只接受 task-N 或 reflection）：{phase}")

    n = int(m.group(1))
    if n < 1 or n > k:
        die(f"ERROR: --phase=task-{n} 超出计划（有效范围 task-1 ~ task-{k}）")

    if n > 1 and not has_prior_evidence(output_dir, log_data, n - 1):
        die(
            f"ERROR: 不能 --phase task-{n}：task-{n - 1} 既没有 search/fetch 记录，"
            f"也没有 {CONCLUSIONS_DIRNAME}/task_{n - 1}.md。\n"
            f"待写 task-{pointer}「{step_title(steps, pointer)}」。"
        )

    return steps, completed_ids


def validate_save_task(output_dir, task_id, probed=None):
    """save_conclusion.py --type task 硬门：--task-id 必须等于指针，或该号已是 validated 结论（允许覆盖修订）。

    修订不改变指针：待写号仍是第一个还不是 validated 的号，不会因为回改早前任务而回退。
    覆盖本身仍受 save_conclusion.py 里「validated 结论覆盖需 --force / 未受管理文件禁止 --force」的限制。
    probed 是 resolve_output_dir 查找过的路径，仅用于把报错说清楚。
    返回 is_amend：True 表示这是对已完成任务的覆盖修订（而非按指针正常推进）。
    """
    plan_data = load_plan(output_dir)
    if plan_data is None:
        die(missing_plan_message(output_dir, probed))

    steps, completed_ids, pointer = sync_plan_status(output_dir, plan_data)
    valid_ids = {step_num(s) for s in steps}
    if task_id not in valid_ids:
        die(f"ERROR: --task-id={task_id} 超出计划（有效范围 1 ~ {max_step_num(steps)}）")

    is_amend = task_id in completed_ids and task_id != pointer
    if pointer is not None and task_id != pointer and task_id not in completed_ids:
        die(f"ERROR: 不能 save task-{task_id}：待写 task-{pointer}「{step_title(steps, pointer)}」。")

    return is_amend


def validate_save_reflection(output_dir, probed=None):
    """save_conclusion.py --type reflection 硬门：任务结论必须已全部齐。"""
    plan_data = load_plan(output_dir)
    if plan_data is None:
        die(missing_plan_message(output_dir, probed))

    steps, completed_ids, _pointer = sync_plan_status(output_dir, plan_data)
    k = max_step_num(steps)
    missing = missing_ids(steps, completed_ids)
    if missing:
        die(
            "ERROR: 不能保存反思：任务结论未齐（"
            f"{len(completed_ids)}/{k}）。缺 {format_id_list(steps, missing)}。"
        )


def _phase_stats(log_data, phase):
    """Returns (s_total, s_ok, s_fail, f_total, f_ok, f_fail) for a given phase."""
    if not log_data:
        return 0, 0, 0, 0, 0, 0
    searches = [e for e in log_data.get("search", []) if e.get("phase") == phase]
    fetches  = [e for e in log_data.get("fetch",  []) if e.get("phase") == phase]
    s_ok   = sum(1 for e in searches if e.get("status") == "success")
    s_fail = sum(1 for e in searches if e.get("status") == "failed")
    f_ok   = sum(1 for e in fetches  if e.get("status") == "success")
    f_fail = sum(1 for e in fetches  if e.get("status") == "failed")
    return len(searches), s_ok, s_fail, len(fetches), f_ok, f_fail


# ── 检索预算阈值（数据来自 traces8 25 个基线 case、120 个任务阶段的经验分布，v34 复核）──
# 任务级 search 次数分布：       P50=6,    P75=11,  P90=15.1, P95=21.1, max=48。
# 任务级 search+fetch(retrieval)：P50=11.5, P75=17,  P90=25.3, P95=34.3, max=83。
# case 级 search+fetch(retrieval)：P50=67,  P75=74,  P90=116.8, P95=136.4, max=227。
#
# v33 的预算仅由 search 次数决定，会低估真实 Research Workload：真实轨迹里存在
# search=24 / fetch=24（retrieval=48）的 task，单看 search 只是 CRITICAL、尚未 HARD_STOP，
# 但实际已进行 48 次检索动作 + 大量 evidence 处理。v34 让 HIGH/CRITICAL 同时参考
# retrieval = search + fetch，阈值仍锚定基线分布，不是拍脑袋的整数：
BUDGET_HIGH_SEARCHES = 12          # > P75(11) search：进入收敛区
BUDGET_CRITICAL_SEARCHES = 21      # ≥ P95(21.1) search：停止面上探索
BUDGET_HARD_STOP_SEARCHES = 30     # 历史极端长尾（仅约 3.3% task）：唯一代码层硬停
BUDGET_HIGH_RETRIEVAL = 18         # > P75(17) retrieval：workload 进入 HIGH
BUDGET_CRITICAL_RETRIEVAL = 26     # > P90(25.3) retrieval：workload 进入 CRITICAL
BUDGET_HARD_STOP_RETRIEVAL = 35    # ≥ P95(34.3) retrieval：task 级检索硬停（search 之外的第二道硬门）

# case 级全局 Research Workload（search+fetch）软提醒线——只改研究深度，绝不 hard stop：
BUDGET_GLOBAL_RETRIEVAL_SOFT = 73     # ≈ case P75(74)：停止 optional 扩展，为剩余 task 留预算
BUDGET_GLOBAL_RETRIEVAL_STRONG = 90   # 明显高于 P75、低于长尾跳变(127/134/227)：剩余 task 转 core-only

# v40：task 级硬门由 search≥30 扩为 search≥30 OR retrieval≥35（retrieval=search+fetch），
# 同时对 baidu_search 与 fetch_webpage 生效（见 check_retrieval_hard_gate）；reflection 阶段
# 由全局 retrieval≥BUDGET_GLOBAL_RETRIEVAL_STRONG(90) 硬停新的 Search/Fetch。
SCRIPTS_DIR = os.path.dirname(os.path.abspath(__file__))


def budget_state(search_count, retrieval_count=None):
    """把当前任务的 workload 映射到 NORMAL/HIGH/CRITICAL/HARD_STOP。

    HARD_STOP 由 search 次数或 retrieval(search+fetch) 触发：search≥BUDGET_HARD_STOP_SEARCHES
    或 retrieval≥BUDGET_HARD_STOP_RETRIEVAL（唯一代码层硬门，见 check_retrieval_hard_gate）。
    HIGH / CRITICAL 同时参考 retrieval = search + fetch；retrieval_count 省略时退化为
    纯 search 判断（供只关心 search 门的调用方复用）。
    """
    retrieval = retrieval_count if retrieval_count is not None else search_count
    if search_count >= BUDGET_HARD_STOP_SEARCHES or retrieval >= BUDGET_HARD_STOP_RETRIEVAL:
        return "HARD_STOP"
    if search_count >= BUDGET_CRITICAL_SEARCHES or retrieval >= BUDGET_CRITICAL_RETRIEVAL:
        return "CRITICAL"
    if search_count >= BUDGET_HIGH_SEARCHES or retrieval >= BUDGET_HIGH_RETRIEVAL:
        return "HIGH"
    return "NORMAL"


def _phase_search_count(log_data, phase):
    """当前 phase 的 search 记录条数。"""
    if not log_data:
        return 0
    return sum(1 for e in log_data.get("search", []) if e.get("phase") == phase)


def _phase_fetch_count(log_data, phase):
    """当前 phase 的 fetch 记录条数。"""
    if not log_data:
        return 0
    return sum(1 for e in log_data.get("fetch", []) if e.get("phase") == phase)


def _save_conclusion_cmd(task_num):
    """生成当前 task 的 save_conclusion 具体调用（免去 Agent --help / 读源码自检）。"""
    path = os.path.join(SCRIPTS_DIR, "save_conclusion.py")
    return (
        f"python {path} --type task --task-id {task_num} << 'EOF'\n"
        "[完整任务结论]\nEOF"
    )


def _global_convergence_hint(log_data, steps=None, completed_ids=None):
    """case 级 Research Workload 软收敛提示：只降后续研究深度，绝不跳过 task。"""
    if not log_data:
        return ""
    g_retr = len(log_data.get("search", [])) + len(log_data.get("fetch", []))
    if g_retr < BUDGET_GLOBAL_RETRIEVAL_SOFT:
        return ""
    total = max_step_num(steps) if steps else 0
    done = len(completed_ids) if completed_ids else 0
    remaining = total - done if total else 0
    # 全部 task 已完成（remaining<=0）时无「剩余 task」可保护，不再输出软收敛提示，
    # 避免出现「剩余 0 个核心任务 / 为剩余 task 保留预算」这类自相矛盾的引导。
    if total and remaining <= 0:
        return ""
    prefix = f"全局 Research Workload 已偏高（retrieval {g_retr}）"
    if total:
        prefix += f"，已完成 {done}/{total} 个 task，剩余 {remaining} 个核心任务"
    if g_retr >= BUDGET_GLOBAL_RETRIEVAL_STRONG:
        return (
            prefix + "。整个 case 进入高 Research Workload 区间：剩余 task 采用 core-only research"
            "——只覆盖用户明确要求、优先一手/高质量来源，已有可靠证据即不再为增加案例数量继续搜索，"
            "边缘缺口记 limitation。不跳过任何 task。"
        )
    return (
        prefix + "。当前 task 停止扩展 optional angle，完成核心 evidence 后尽快 save_conclusion，"
        "为剩余 task 保留研究预算。不跳过任何 task。"
    )


def check_retrieval_hard_gate(phase, log_data):
    """唯一的代码层检索硬停，供 baidu_search.py 与 fetch_webpage.py 在发起真正网络请求前调用。

    - phase == task-N：本 task 的 search ≥ BUDGET_HARD_STOP_SEARCHES(30)
      或 retrieval(search+fetch) ≥ BUDGET_HARD_STOP_RETRIEVAL(35) → 同时禁止新的 Search 和 Fetch。
    - phase == reflection：全局 retrieval ≥ BUDGET_GLOBAL_RETRIEVAL_STRONG(90) → 禁止新的 Search 和 Fetch。
    - 其它情况放行。

    硬停只看计数，不看 novelty / query 内容 / 声明。硬停后仍允许：读取已抓取文件、
    grep 已有 content_file 做证据提取、本地分析、save_conclusion、记 limitation——
    只禁止新的 baidu_search / fetch_webpage。返回 None 放行，或返回拒绝文案（无 ask_user）。
    """
    m = PHASE_TASK_RE.match(phase or "")
    if m:
        s_count = _phase_search_count(log_data, phase)
        f_count = _phase_fetch_count(log_data, phase)
        retr = s_count + f_count
        if s_count < BUDGET_HARD_STOP_SEARCHES and retr < BUDGET_HARD_STOP_RETRIEVAL:
            return None
        return (
            f"RETRIEVAL_BLOCKED\n\n当前 task 已执行 search {s_count} 次、retrieval "
            f"{retr} 次（search+fetch），达到检索硬停区间"
            f"（search ≥ {BUDGET_HARD_STOP_SEARCHES} 或 retrieval ≥ {BUDGET_HARD_STOP_RETRIEVAL}）。\n\n"
            "禁止新的 Search/Fetch。请使用已有 evidence 收敛结论，缺口记 limitation，然后 save_conclusion。\n\n"
            "仍允许：读取已抓取文件、grep 已有 content_file、本地分析、save_conclusion.py。\n\n"
            "INTERACTION_RULE: NO_ASK_USER"
        )

    if phase == "reflection":
        g_retr = len((log_data or {}).get("search", [])) + len((log_data or {}).get("fetch", []))
        if g_retr < BUDGET_GLOBAL_RETRIEVAL_STRONG:
            return None
        return (
            f"RETRIEVAL_BLOCKED\n\n全局 retrieval 已达到 {g_retr} 次（search+fetch），"
            f"达到 strong limit（≥ {BUDGET_GLOBAL_RETRIEVAL_STRONG}）。\n\n"
            "Reflection 不再允许新的 Search/Fetch。请基于现有 task conclusions / fetched evidence "
            "完成综合，缺口记 limitation。\n\n"
            "仍允许：读取已抓取文件、grep 已有 content_file、本地分析、save_conclusion.py。\n\n"
            "INTERACTION_RULE: NO_ASK_USER"
        )

    return None


def dynamic_next_step(phase, log_data, status, kind, steps=None, completed_ids=None):
    """按 task Research Workload 预算 + 本次结果生成 search & fetch 返回里的「下一步」。

    预算同时参考 search 与 retrieval(search+fetch)；HIGH/CRITICAL/HARD_STOP 分支直接给出
    当前 task 的 save_conclusion 具体命令，Agent 无需 --help / 读源码即可收敛。
    grep/read 已抓取的 content_file 做 evidence 提取始终允许（不受预算限制）。
    末尾附全局 Research Workload 软收敛提示（只降研究深度，绝不跳过 task）。
    """
    m = PHASE_TASK_RE.match(phase or "")
    is_task = bool(m)
    s_count = _phase_search_count(log_data, phase)
    f_count = _phase_fetch_count(log_data, phase)
    budget = budget_state(s_count, s_count + f_count)

    if kind == "search":
        base = ("从本次 search 结果中选择最相关的候选 URL，使用 fetch_webpage.py 抓取正文。"
                if status == "success"
                else "本次 search 未获得可用结果；若仍有未处理的已有候选 URL，优先继续 fetch，"
                     "否则调整查询后继续 search。")
    else:
        base = ("读取本次 content_file，并执行 Step C 缺口判断。"
                if status == "success"
                else "本次 fetch 未获得可用正文；跳过当前 URL，优先抓取已有 search 结果中的"
                     "其他候选 URL，候选不足时再继续 search。")

    if not is_task:
        return base

    task_num = int(m.group(1))
    save_hint = _save_conclusion_cmd(task_num)
    evidence_ok = ("（对已抓取的 content_file 做 grep/read 精确证据提取始终允许，"
                   "不计入检索预算）")

    if budget == "HARD_STOP":
        step = ("本 task 已达检索硬停区间（search ≥ 30 或 retrieval ≥ 35）：不再新增 Search/Fetch。"
                "使用已有 evidence 完成 conclusion，无法可靠获取的数据记录 limitation，直接调用以下命令保存并进入下一任务"
                f"（无需 --help / 无需读取脚本源码）：\n{save_hint}\n" + evidence_ok)
    elif budget == "CRITICAL":
        step = (base + " ⚠ Research Workload CRITICAL：停止面上探索，禁止为「多举几个例子 / 数据更漂亮 / "
                "覆盖边缘 / optional 扩展」继续检索。先处理已有 evidence 完成 Step C 缺口判断与结论综合，"
                "仅对仍未解决的核心 requirement 做必要定向补充，其余记 limitation，然后尽快保存结论"
                f"（无需 --help / 无需读取脚本源码）：\n{save_hint}\n" + evidence_ok)
    elif budget == "HIGH":
        step = (base + " ▶ Research Workload HIGH，已进入收敛区：先处理已有 evidence 并判断核心缺口，"
                "不要为 optional angle 扩展检索；若核心 requirement 已覆盖，直接保存结论"
                f"（无需 --help / 无需读取脚本源码）：\n{save_hint}\n" + evidence_ok)
    else:
        step = base

    global_hint = _global_convergence_hint(log_data, steps, completed_ids)
    if global_hint:
        step = step + "\n" + global_hint
    return step


def render_progress_block(steps, completed_ids, this_phase, log_data=None, next_step=None):
    """生成 search / fetch stdout 里的 progress 文本块。

    「研究进度」直接取本次 --phase 的任务号 N（task-N → N/k）；--phase reflection
    时只有在任务结论已全部齐（硬门已保证）才会调用到这里，所以直接记为 k/k。
    不再单独统计日志里出现过的任务号，避免和「研究中」的号错位。
    log_data: 已更新（含本次调用）的 research_log 数据，用于统计当前 phase 活动。
    next_step: 根据本次 Search/Fetch 结果动态生成的下一步提示。
    """
    k = max_step_num(steps)
    completed = len(completed_ids)
    pointer = first_missing_id(steps, completed_ids)

    m = PHASE_TASK_RE.match(this_phase or "")
    current_num = int(m.group(1)) if m else None
    current_label = (
        f"task-{current_num}「{step_title(steps, current_num)}」"
        if current_num is not None
        else "全局反思"
    )

    reached = current_num if current_num is not None else k

    lines = []
    header = f"研究进度：{reached}/{k}，完成进度：{completed}/{k}"
    if pointer is not None:
        header += f"，待写：task-{pointer}"
    lines.append(header)
    lines.append(f"研究中：{current_label}")

    if completed_ids:
        lines.append("已完成：")
        for n in sorted(completed_ids):
            lines.append(f"  task-{n}「{step_title(steps, n)}」")

    shown = set(completed_ids)
    if pointer is not None:
        shown.add(pointer)
    if current_num is not None:
        shown.add(current_num)
    not_started = sorted(step_num(s) for s in steps if step_num(s) not in shown)
    if not_started:
        lines.append("未开始：")
        for n in not_started:
            lines.append(f"  task-{n}「{step_title(steps, n)}」")

    is_reflection = (this_phase == "reflection")
    phase_label = "reflection" if is_reflection else "task"

    s_total, s_ok, s_fail, f_total, f_ok, f_fail = _phase_stats(log_data, this_phase)
    retr_total = s_total + f_total
    lines.append(
        f"当前 {phase_label} 活动：search {s_total} 次（可用 {s_ok}，失败 {s_fail}）；"
        f"fetch {f_total} 次（可用 {f_ok}，失败 {f_fail}）；retrieval 合计 {retr_total} 次。"
    )

    g_search = len((log_data or {}).get("search", []))
    g_fetch = len((log_data or {}).get("fetch", []))
    g_retr = g_search + g_fetch
    g_line = f"全局累计：search {g_search} 次 / fetch {g_fetch} 次 / retrieval {g_retr} 次"
    if g_retr >= BUDGET_GLOBAL_RETRIEVAL_STRONG:
        g_line += (f"（全局 Research Workload 很高 ≥{BUDGET_GLOBAL_RETRIEVAL_STRONG}，"
                   "剩余 task 转 core-only research，不跳过任何 task）")
    elif g_retr >= BUDGET_GLOBAL_RETRIEVAL_SOFT:
        g_line += (f"（全局 Research Workload 偏高 ≥{BUDGET_GLOBAL_RETRIEVAL_SOFT}，"
                   "停止 optional 扩展，为剩余 task 保留预算）")
    if not is_reflection and current_num is not None:
        budget = budget_state(s_total, retr_total)
        budget_hint = {
            "NORMAL": "正常研究阶段，允许受控发散",
            "HIGH": (f"已进入收敛区（search ≥{BUDGET_HIGH_SEARCHES} 或 retrieval ≥{BUDGET_HIGH_RETRIEVAL}）："
                     "先消化已有 evidence，只补核心缺口"),
            "CRITICAL": (f"高 Workload 区间（search ≥{BUDGET_CRITICAL_SEARCHES} 或 retrieval ≥{BUDGET_CRITICAL_RETRIEVAL}）："
                         "停止面上探索，尽快 save_conclusion"),
            "HARD_STOP": (f"检索硬停（search ≥{BUDGET_HARD_STOP_SEARCHES} 或 retrieval ≥{BUDGET_HARD_STOP_RETRIEVAL}）："
                          "停止 Search/Fetch，收敛结论 / 记 limitation"),
        }[budget]
        lines.append(f"检索预算：{budget}；{budget_hint}")
        lines.append(g_line)
    else:
        lines.append(g_line)
    lines.append("")
    if next_step:
        lines.append(f"下一步：{next_step}")
        lines.append("")
    lines.append("禁止中断：后续深度研究任何时刻禁止 ask_user！不得转向用户确认！")
    lines.append("工具限制：深度研究任何时刻，检索/抓取不得改用 baidu-ai-search 或 web-reader！")
    lines.append("")
    if is_reflection:
        lines.append("证据缺口：补搜后仍不足则在 reflection 中明确记录全局信息不足，并保存本轮 reflection 结论。")
        lines.append("结论保存：使用 save_conclusion.py；保存成功才算当前 reflection round 完成。")
    else:
        lines.append("证据缺口：公开数据不足/来源口径差异 → 补搜；仍不足则在结论中记录 limitation，并保存当前 task 结论。")
        lines.append("结论保存：使用 save_conclusion.py；保存成功才算当前 task 完成。")
    lines.append("最终报告：仅在全部任务结论 + reflection 完成后，使用 save_report.py --write。")
    return "\n".join(lines)
