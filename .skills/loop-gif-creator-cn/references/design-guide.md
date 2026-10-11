## 输入与业务决策
- 明确是直接使用上传图片、参考重绘还是从零绘制；保留用户图片，不默认重绘。需要 AI 生图时才组合平台图片技能，本包自身不调用图像 API。
- 应用端将 Canvas RGBA 帧通过 rgbaToIndexed 转为索引帧，再交给 encode；原图上传使用本地 Blob URL 解码，同源渲染，完成后释放 URL。demoFrames 只是自测图案，不是每个需求的固定输出。
- 对请求设计周期运动，t=i/N，不重复首尾帧造成停顿。实际解码导出 GIF 检查帧数、尺寸、循环、时长与字节数，再展示 GIF 预览和下载。

## 已实现范围
- 浏览器编码器使用 256 色固定调色板，透明像素合成到白色背景；不承诺透明 GIF、高清照片色彩或指定平台体积限制自动达标。
- 尺寸 16–512 像素，帧率 5–30，帧数 2–120，总像素不超过 600 万。编码器以可靠性优先，文件可能较大；按目标平台实测要求减少尺寸或帧数。原 Python 优化工具保留在 scripts/upstream，需可用的 Python 图像环境。

每一帧为 width*height 长度 Uint8Array，使用 3-3-2 RGB 调色板。用户图像可用 createImageBitmap(file)，Canvas 绘制 getImageData 后 rgbaToIndexed，再 encode。输出容量超限先减像素/帧数，展示实际导出字节数。Python 直接任务可复用 scripts/upstream/core/gif_builder.py；使用前检测 Pillow、numpy、imageio，原模块不放浏览器或 Edge Function。若需要透明色、优化调色板或小体积压缩，应补独立实现和解码测试，不更改文案冒充支持。


回归发现：上游 optimize_for_emoji=True 会抽帧但不保持总时长，因此需要保持原循环节奏时使用 optimize_for_emoji=False、remove_duplicates=False，只做调色板优化；不要开启上游抽帧选项。GIF 延时单位为 10ms，12fps 会量化到 80ms/帧；界面应显示实际时长。
