# 运行集成与验证

直接任务：编写输入 JSON，在技能根目录运行 CLI。CLI 拒绝覆盖已有文件。生成应用：将 assets/runtime.mjs 复制进应用源码目录再 import；应用运行时不能引用技能文件系统。HTML 是可运行参考，不强制产品照抄界面。

```sh
node scripts/test.mjs
node scripts/run.mjs assets/example.json result.gif
python3 -m http.server 8765 --directory assets
```

使用 HTTP 服务打开 assets，file:// 会阻止样例 fetch；8765 占用时选择空闲端口。必须用实际输入测试，不只测 fixture。产品中将 JSON 编辑框换成业务控件，保留 loading、error、result 状态；输入失败清除旧下载链接，原始输入保持不变。

组合平台模型时按 example 约定返回结构化 JSON，返回后校验，并真实展示模型错误。不执行模型代码，不用样例悄悄替代失败结果。只有确需相应格式导入导出时才组合平台 PDF/Word/Excel 技能。

静态 Web 应用默认 HashRouter，除非实测服务端支持深层路由回退。异步结果绑定当前请求，废弃旧任务。文件保持 Blob/Uint8Array，不把二进制转字符串。测试刷新、错误输入、真实下载及下载文件重开。

验证层级依次为：单元契约、实际产物解码、浏览器流程、平台模型接入、QA 生成应用、发布态。包外验证报告仅记录实际执行的层级。
