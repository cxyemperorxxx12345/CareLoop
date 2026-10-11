# 营养计算与数据契约
应用运行期使用 TypeScript 完成确定性计算，不运行本地脚本。
- BMI = kg / m²，仅作筛查背景。
- 能量目标显示公式、活动系数、目标调整量和区间，允许手动覆盖。
- 蛋白质与碳水按4 kcal/g，脂肪按9 kcal/g。
- 汇总来自结构化食材记录，不解析模型自然语言数字。
- 缺少可靠来源的食品值标记 estimated=true。
最小数据：profile、targets、weeklyPlan、meal、ingredient、foodLog、review。金额、份量和重量必须非负；食材改变后重算营养与购物清单；单位采用克、毫升、千卡和人民币。
