# 前端任务状态与恢复契约

## 已定位的故障
首次创建响应是 submitted，被写入 savedJobRef.current。页面用 savedJobRef.current ?? job 渲染，导致后续轮询虽已取得 succeeded，旧 ref 仍永久优先，播放器不出现。ref 更新本身也不会触发 React 渲染。

## 必须采用的实现规则
- 当前任务只保留一个用于渲染的 React state。创建、查询、保存结果通过同一个受控入口更新它；禁止用创建快照、缓存或 ref 覆盖最新状态。ref 只存请求代次、取消句柄等非展示数据。
- 使用 assets/task-state.mjs 的 taskStateGate：切换任务时 select(id)，每次请求前捕获 ticket()，响应后 accept(ticket,response)，仅非 null 结果进入 setJob。卸载/停止/重启轮询时 invalidate()。React StrictMode effect 重建需建立新代次；不用跨 effect 的 runningRef 阻止新轮询启动。
- 在每次 await 返回后同时检查当前代次、active/卸载状态和响应 id。旧任务响应、卸载后响应全部丢弃。成功/失败终态不被旧的 submitted/processing 覆盖；同任务保存响应也走同一入口。
- 每次查询结束后延迟 5 秒再查，使用串行循环而不是 setInterval；成功/失败立即停，15 分钟结束本轮并显示可恢复查询的超时提示，不把本地等待超时写成上游失败，不重新创建计费任务。
- 查询异常展示错误和恢复查询入口，保留任务 ID 和已有结果；重试只 query。创建返回后使用同一任务 ID，不因渲染、刷新或保存失败调用 create。
- 刷新时可从 URL 的 job 参数恢复，或通过已登录用户的 list 恢复。URL ID 仅是定位信息，服务端仍逐次核对归属。账户切换清空旧状态，恢复请求也须防止覆盖用户刚选的新任务；恢复失败明确显示，不吞错。
- 页面成功状态直接使用 job.state 和 job.media 渲染播放器及下载入口，can_save=false 仅隐藏私有转存按钮。不要将 save_reason 显示成生成失败。
- 历史页每个 ID 同样使用单状态源；数据库新记录不能被 prev[id] ?? latest 的旧快照遮住。保存后用 state 更新，不能只改 ref。

## 生成期回归检查
1. submitted → processing → succeeded，最后一次响应到达即显示媒体，无需刷新。
2. 初次创建快照仍是 submitted 时，后续成功响应仍获采用。
3. A 慢响应晚于切换到 B，A 不覆盖 B；卸载、StrictMode 重建不留下旧轮询更新。
4. 成功后迟到 submitted 被丢弃；同任务保存成功可更新 saved。
5. 刷新恢复已有成功结果和进行中任务；恢复旧请求不覆盖新提交；用户 B 不能恢复 A 的任务。
6. 查询失败或等待超时只恢复查询；can_save=false 时成功媒体仍可见。
离线契约测试与用户反馈不替代新生成应用的 QA 浏览器验收。
