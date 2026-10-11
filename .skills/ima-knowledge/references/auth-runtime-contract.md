# 鉴权与首页生成契约 r13

适用于 ima 知识库阅读器生成和修订。用户 Query 只写业务需求；本文件规定生成代码和验收，不要求用户粘贴技术补丁。

## 三层凭据，各自使用
| 层 | 用途 | 位置 |
|---|---|---|
| 平台公开 key/anon key | 平台项目识别及网关要求 | 按平台规则；不是个人身份 |
| 用户 session access token | 识别当前登录用户，决定允许读取哪些知识库/文件 | 前端会话→后端验证；不得用空字符串替代 |
| ima Client ID/API Key | 后端调用 ima；代表对应 ima 账号的数据权限 | 服务端秘密配置；禁止返回浏览器 |
| Office 兼容预览 | 浏览器渲染原文件 | r16不需要额外服务令牌，原文件权限校验保留 |

## 生成顺序
1. 修改应用时先保留已验证的登录、凭据配置、列表、PDF/PNG/TXT路径；不因增加Office转换而重写这些模块。
2. 新应用读取个人知识库时，生成完整身份和访问授权链路：实际挂载登录上下文及登录入口，等待会话初始化，未登录时展示登录界面而不是发出私有列表请求。
3. 前端取得有效 session token，按平台网关要求发送 Authorization/apikey；后端验证身份，并绑定到该用户可用的 ima 凭据和知识库范围。有效session也不意味着可读取任意 media_id。
4. 若用户明确选择公开阅读，须先确认公开数据范围，再实现公开集合白名单；不可仅凭公开 anon key 读取服务器 ima 凭据下所有知识库。私人凭据配置入口不得公开。
5. 初始化只检查现有ima所需配置；r16无Office URL/令牌配置，不影响search_kb/list_content/preview_proxy。
6. 获取真实元数据后确定Office文件扩展名；不得接受前端filename作为唯一依据，尤其不能将PPT默认成docx。浏览器文件内容和后缀双重检查见 office-runtime.md。

## 首页状态
使用互斥状态 loading / error / success：
```tsx
if (loading) return <LoadingView />;
if (error) return <LoadError message={error.message} onRetry={reload} />;
if (items.length === 0) return <EmptyView />;
return <KnowledgeBaseList items={items} />;
```
EmptyView仅在成功请求返回空数组时显示。HTTP 401不是“暂无知识库”，也不是“文件解析失败”。已有数据刷新失败时可以保留旧列表，但标出刷新失败，不宣称新结果已更新。

## 401排查，不猜测、不删门禁
先抓取实际请求action、HTTP状态、脱敏响应、请求鉴权来源与已部署函数版本。分别确认：
- 平台网关是否在进入函数前拒绝；
- 应用函数是否因session不存在/过期或访问范围不匹配拒绝；
- ima上游是否拒绝配置的凭据；
- r16不应发office_preview或请求转换器令牌。
不得凭单个 unauthorized 字符串认定是哪层，不以关闭JWT校验/删除getUser作为通用修复。修复后同一请求重测；记录本地、已部署、真实接口三个状态，不能混用。

## 提交验收
- 静态：运行 test-reader-source.py 和 check-reader-source.py APP。扫描只是告警，识别不到自定义鉴权时人工提供代码/部署证据；不要改名绕过。
- 首页：未登录、有效登录、过期会话、正常非空列表、成功空列表、上游凭据错误。
- 权限：用户A读取用户B知识库/文件返回拒绝；没有授权时不给原字节。
- 隔离：Office转换配置缺失时，正常列表、PDF、PNG、TXT仍可用；Office展示配置缺失，不算完成。
- 保留：切换、刷新、原文件下载、错误重试均检查真实结果。
- 完成：只有目标QA已部署链路通过，才报告“已修复”；本地规则和模拟测试通过不等于QA成功。
