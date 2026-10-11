# 前端 Debug 准则

适用症状：按钮无响应、状态不更新、白屏、样式错乱、元素被裁剪、重叠/透底、交互失效。

---

## 状态与渲染

### 排查范围要覆盖整条状态流转路径

只盯用户当前抱怨的表面症状会漏掉真正的断点。沿该功能的完整状态流转路径走一遍：触发 → 中间状态 → 最终状态。特别检查：

- 弹窗/模态框是否在该关的时候关了
- 状态标志位是否重置
- 联动组件是否同步更新

症状点往往只是链路末端的表现，根因常在上游的状态流转里。

### 受控组件先查官方组合约定

使用 Radix/shadcn Tabs、Accordion、Select 等受控组件出现异常时，先用官方文档确认合法子节点结构。常见错误：把内容面板放在 Tabs 外部或用非约定子节点（条件渲染的 Fragment、div）直接塞进受控容器。

### 区分 dev warning 和 production 崩溃

遇到只在发布态出现的白屏/崩溃：

- 先在生产构建上加 Error Boundary 捕获真实错误信息
- 对比 preview 与 production 的构建产物、数据量、平台外壳差异
- 不要围绕 dev-only warning（如 key prop warning）做连续修补

### PostgREST 嵌套查询返回结构

Supabase 嵌套查询对 to-one FK 关系返回单个对象，对 to-many 返回数组。用数组下标 `[0]` 访问 to-one 结果恒为 undefined。遇到"展开后空白/数据存在但不渲染"时，先确认数据访问路径与返回结构是否匹配。

---

## 样式与布局

### overflow 裁剪问题

当下拉/弹出层被父容器边框裁剪时：

- 检查 DOM 祖先链上是否有 overflow:hidden / overflow:auto
- CSS 规范下 absolute 子元素无法逃离设置了 overflow 裁剪的祖先
- 正确方案：createPortal 到 document.body + position:fixed + getBoundingClientRect 计算位置
- 调 z-index 或改弹出方向无法解决 overflow 裁剪

### 视觉重叠/透底先查背景图

页面出现视觉重叠、底层内容透出时，先查 background-image 引用的静态图片本身是否就是一张包含旧 UI 的完整效果图。若图本身画了 UI 元素，需要替换为纯色/渐变，而不是调 z-index 或透明度做遮盖。

### 尺寸测量在 transform 上下文下是否可信

依赖 getBoundingClientRect 做布局/缩放时，如果元素或祖先有 CSS transform，返回值是变换投影后的尺寸（宽高可能互换/缩放）。应改用 offsetWidth/offsetHeight，或把内容放进固定比例容器用 CSS 百分比填充。反复调数值前，先断言测量值是否等于你以为的物理尺寸。

### 移动端/iframe 不依赖视口高度做等比缩放

window.innerHeight / clientHeight 在不同浏览器、工具栏状态、iframe 加载时序下会变化。优先采用"按宽度等比缩放 + 垂直滚动"或 CSS 百分比/object-fit 等不依赖精确高度的方案。

### 样式/布局类验收要用数值断言

样式错乱、元素被裁剪、重叠/透底这类视觉问题，jsdom 复现不出（不算 CSS、不做布局），必须用 ③ browser mode 在真实 Chromium 里读数值：`toBeVisible`、`toBeInViewport`、`getBoundingClientRect` 的尺寸与矩形相交、`scrollWidth/clientWidth` 判溢出、`elementFromPoint` 判遮挡、`getComputedStyle` 查 opacity/z-index。具体写法见 [vitest-testing.md](../references/vitest-testing.md) 的「视觉与布局 bug」。

注意 `toBeVisible` 对 `opacity: 0` 仍判为 visible，透明度类问题要查 `getComputedStyle`。不用截图比对做验收。组件级渲染与真实页面仍可能有偏差（真实数据、真实 CSS 层叠、真实视口），这部分如实说明未验证，交给用户在预览中确认。视觉/Canvas/3D 类更详细的验收方法见 [visual.md](visual.md)。

---

## 交互

### 浏览器能力依赖型功能要分层设计

实现依赖浏览器特定 API 的功能（如 PWA 安装、Web Share 等）时，不能用单一布尔标志控制 UI 可见性。按能力分层：

- 完全支持：直接触发原生功能
- 部分支持：显示引导步骤
- 不支持：明确提示或提供替代方案

---

## 排查顺序（定位根因用）

1. 先确认数据是否到达前端（Network 面板 / console.log）
2. 再确认渲染逻辑是否执行（条件判断、数据访问路径）
3. 最后查样式/布局问题（overflow、z-index、定位）

如果症状是"数据存在但不显示"，大概率是渲染逻辑问题而非样式问题。
