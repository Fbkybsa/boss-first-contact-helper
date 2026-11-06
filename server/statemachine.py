"""投递状态机。

核心规则（与方案一致）：
- 招聘阶段与查看状态分开判定；
- 自动更新只进不退；记录关闭（已拒绝/已撤回/已结束/已入职）后自动更新不再生效；
- 终止类（已拒绝等）与"约面试"及之后的阶段，必须有"确定"证据，否则降级为待确认变更；
- 人工修正优先于一切自动逻辑，且默认对记录加锁（manual_locked）防止被页面旧数据覆盖。

返回统一为 (action, new_value, reason)，action ∈ apply / pending / ignore：
- apply   更新记录并写入状态历史
- pending 不更新记录，只写一条"待确认变更"，等待人工在管理页采纳
- ignore  完全不记录（无变化/被保护/不允许的方向）
"""

FORWARD_STAGES = ["已沟通", "已投递", "约面试", "已面试", "已获Offer", "已入职"]
END_STAGES = ["已拒绝", "已撤回", "已结束"]
CLOSED_STAGES = END_STAGES + ["已入职"]
ALL_STAGES = FORWARD_STAGES + END_STAGES
STAGE_INDEX = {s: i for i, s in enumerate(FORWARD_STAGES)}
# 进入这些阶段必须有"确定"证据（约面试/已面试/已获Offer）
HIGH_STAGES_FROM_INDEX = 2

VIEWED_ORDER = {"未知": 0, "未查看": 1, "已查看": 2}
VIEWED_OPTIONS = list(VIEWED_ORDER)


def stage_index(stage):
    return STAGE_INDEX.get(stage)


def evaluate_stage(current, observed, confidence="确定", manual=False, manual_locked=False):
    if manual:
        return ("apply", observed, "人工修正")
    if observed not in ALL_STAGES:
        return ("ignore", current, f"未知阶段: {observed}")
    if manual_locked:
        return ("ignore", current, "人工保护中，忽略自动变更")
    if observed == current:
        return ("ignore", current, "无变化")
    if current in CLOSED_STAGES:
        return ("ignore", current, "记录已关闭，自动不再变更")
    if observed in END_STAGES:
        if confidence == "确定":
            return ("apply", observed, "明确的终止/拒绝证据")
        return ("pending", current, "终止类变更证据不明确")
    ci, oi = STAGE_INDEX.get(current), STAGE_INDEX.get(observed)
    if ci is None or oi is None:
        return ("ignore", current, "阶段值异常")
    if oi > ci:
        if oi >= HIGH_STAGES_FROM_INDEX and confidence != "确定":
            return ("pending", current, "进入面试及之后的阶段需要确定证据")
        return ("apply", observed, "阶段前进")
    return ("ignore", current, "不允许自动后退")


def evaluate_viewed(current, observed, confidence="确定", manual=False, manual_locked=False):
    if manual:
        return ("apply", observed, "人工修正")
    if observed not in VIEWED_ORDER:
        return ("ignore", current, f"未知查看状态: {observed}")
    if manual_locked:
        return ("ignore", current, "人工保护中，忽略自动变更")
    if observed == current:
        return ("ignore", current, "无变化")
    if VIEWED_ORDER[observed] > VIEWED_ORDER.get(current, -1):
        return ("apply", observed, "查看状态前进")
    return ("ignore", current, "不允许自动后退")
