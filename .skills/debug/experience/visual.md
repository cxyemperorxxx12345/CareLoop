# 视觉验收 Debug 准则

适用症状：看不见/没生成/显示异常、Canvas 黑屏。

---

## 核心原则：以真实渲染为最终判据

排查任何"看不见/没生成/显示异常"的视觉问题时，不能只靠控制台日志、代码阅读或局部参数推断做症状性判断。必须先拿到真实渲染证据：

- 用 ③ vitest + browser mode 在真实 Chromium 里渲染组件，断言数值判据（`toBeVisible`、`getBoundingClientRect` 尺寸/位置、矩形是否相交、`elementFromPoint` 命中、canvas 像素非空、实例数量、DOM 结构）
- 禁止只靠日志、无实际渲染就下根因结论
- jsdom（②）不算 CSS、不做布局，视觉/布局/样式类问题复现不出，必须用 ③

---

## Canvas

### 常见隐藏根因

- 相机位置错误：初始化时相机在地形内部或远离场景，方块材质单面渲染导致内部不可见
- frustum culling 配置：InstancedMesh 默认以原点几何体为界做视锥剔除，相机位移后整个世界被错误剔除
- 渲染循环未启动：条件守卫（如 isLocked 检查）导致 camera.position.copy 从未执行

### 排查思路

1. 先确认渲染循环是否在执行（useFrame/requestAnimationFrame 是否被跳过）
2. 确认相机位置是否在可见范围内
3. 确认场景中的物体是否被 culling 规则剔除
4. 确认材质/光照是否正确（单面渲染、无光照 = 黑色）
5. 用 browser mode 断言修复前后可观测状态的变化（mesh/实例数量、相机位置、元素尺寸；2D canvas 用 `getImageData` 判非空，WebGL 场景断言场景对象而不是取像素）


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
---

## browser mode 复现方法

用 ③ vitest + browser mode（真实 Chromium，见 [vitest-testing.md](../references/vitest-testing.md) ③）：

- 在浏览器里渲染出问题的组件/页面
- 断言可观测判据：元素是否存在、`getBoundingClientRect()` 的尺寸与位置、canvas 是否有内容、层叠/重叠关系
- 明确写出你断言的是什么（"元素缺失"/"位置错乱"/"两个卡片重叠"），而不是"看起来有问题"
- 最终验收以 browser mode 的数值判据为准：`toBeVisible`、`toBeInViewport`、`getBoundingClientRect` 的尺寸与矩形相交、`scrollWidth/clientWidth`、`elementFromPoint` 判遮挡、`getComputedStyle` 查 opacity/z-index、canvas `getImageData` 判非空。写法见 [vitest-testing.md](../references/vitest-testing.md) 的「视觉与布局 bug」。
- 不用截图比对做验收。组件级渲染与真实页面（真实数据、CSS 层叠、视口、字体图片加载）可能有偏差，这部分如实说明未验证，由用户在预览中确认。

console 报错是比渲染更硬的证据——组件渲染时如有 console.error / 抛错，优先顺着它排查。

---

## 排查顺序（定位根因用）

1. browser mode 渲染确认当前实际呈现了什么（数值判据）
2. 检查渲染时的 console 报错 / 抛错（最硬的证据）
3. 确认渲染循环/生命周期是否正常执行
4. 确认关键对象（相机、场景、mesh）的位置和状态
5. 确认 culling/clipping/visibility 配置
