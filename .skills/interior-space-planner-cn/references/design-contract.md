# 方案数据契约
核心对象：project、constraint、room、option、item、budgetLine、visualization。
constraint.confidence 只允许 confirmed、drawing、inferred、verify；immutable=true 的约束不得出现在拆改建议。
尺寸采用毫米或平方米的规范值；金额必须是范围并由预算条目汇总。效果图版本关联 option_id，不覆盖源版本。
