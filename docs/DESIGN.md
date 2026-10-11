# 愈见 CareLoop UI 设计基准（源自 tasks/ui-design.md，本轮唯一设计参考）

## Vibe
- Scandinavian healthcare functionalism（北欧医疗功能主义）：临床级冷静、留白克制、信息即设计

## Color
- Primary: #0E7C86（青绿：专业+生命感）
- On Primary: #FFFFFF
- Accent: #0284C7（信息蓝）
- On Accent: #FFFFFF
- Background: #F6F8FA
- Foreground: #0F172A
- Muted: #475569（次要文字）
- Border: #E2E8F0
- Secondary: #0A5E66（主色深，hover/按下）
- 语义色全站唯一定义：绿 #16A34A/#DCFCE7（正常/已完成）、黄 #D97706/#FEF3C7（关注/待处理）、红 #DC2626/#FEE2E2（高危/紧急）、蓝 #0284C7/#E0F2FE（提示/科普）；黄色禁用纯黄 #FBBF24
- 主色浅底 #E6F4F5 仅用于选中态/浅色卡片；辅助文字 #94A3B8 仅限角标/时间戳；Primary/Accent 禁大色块铺底，只落按钮/图标/激活态

## Typography
- Heading: ResourceHanRoundedCN (family: "ResourceHanRoundedCN", weight: 700/900, url: https://resource-static.bj.bcebos.com/fonts-skill/ResourceHanRoundedCN-Heavy.ttf)
- Body: ResourceHanRoundedCN (family: "ResourceHanRoundedCN", weight: 400/500, url: https://resource-static.bj.bcebos.com/fonts-skill/ResourceHanRoundedCN-Regular.ttf)
- 患者端：页面标题 24-26px/700、区块标题 19-20px/600、卡片标题 17px/600、正文 16px（最小 15px）、辅助 14px、角标 12px；行高正文 1.6、标题 1.3
- 医护端：页面标题 22px/600、指标数值 28-32px/700、卡片标题 16px/600、列表正文 14px、辅助 13px

## Visual Language
- 核心视觉签名：风险三重编码徽章系统——同一语义全站以「浅色底 + lucide 线性图标 + 等级文字」呈现（红底+感叹号+「高危」），绝不只靠颜色区分
- 材质与深度：白卡浮于冷灰底；阴影仅两级（卡片 0 1px 2px rgba(15,23,42,.06)、悬浮层 0 8px 24px rgba(15,23,42,.10)），禁多层重阴影
- 容器与按钮：卡片圆角 14px、按钮/输入框 10px、标签全圆角 999px、弹窗 16px；主按钮主色实底白字高 ≥48px，次按钮白底主色描边 ≥40px，移动端点击区 ≥44×44px、相邻间距 ≥8px
- 布局节奏：患者端容器 ≤480px 居中、底部导航常驻 4-5 项、页面层级 ≤2 层；医护端固定侧边栏+选中态主色左竖条+浅底、指标大数值制造「数据感」；间距刻度只用 4/8/12/16/20/24/32/40

## Animation
- 入场：卡片 fade-rise 上移 24px，250-300ms ease-out
- 交互：Tab/卡片切换 200-300ms 过渡；按钮按压 scale 0.97；仅红色未处理预警允许轻微 pulse
- 滚动：升级链路 sticky 高亮随滚动切换；禁跳动动画/循环装饰动效

## Forbidden
- 禁渐变堆叠、霓虹色、炫技入场动画、多层重阴影；禁主色超 1 种、语义色另造新值
- 禁关键信息用纯灰小字承载；禁图标实心/线性混用；禁顺手改业务逻辑/文案/数据结构

## Additional Notes
- 所有文案中文；三端在 375/768/1280 宽度无错位、无溢出、无横向滚动
- 适老化硬性验收：正文对比度 ≥4.5:1、点击区 ≥44px、风险三重编码、表单错误提示写明原因、focus ring 清晰
- 每屏可独立截图进答辩 PPT；视觉记忆点三处最精致：红色预警卡、提醒升级链路、AI 解析前后对比
