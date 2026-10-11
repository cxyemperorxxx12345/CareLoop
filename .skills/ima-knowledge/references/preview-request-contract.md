# PDF/PNG 请求双端接线（r14）

已复现回退：前端发送 media_id，后端读取 mediaId，下载之前返回400。不要修改渲染器来处理此错误。

## 必须一起采用的代码
前端复制 preview-request.mjs、preview-response.mjs、preview-bytes.mjs，调用 fetchPreviewBlob({endpoint,mediaId,headers,signal})。mediaId 是函数参数名，JSON 字段由 previewRequest 固定为 media_id。

后端复制 preview-request.mjs，在现有登录校验、权限控制之后接入：
```js
case 'preview_proxy': {
  let mediaId;
  try { mediaId = readPreviewRequest(body); }
  catch { return new Response(JSON.stringify({error:'invalid_preview_request'}), {
    status:400, headers:{...corsHeaders,'Content-Type':'application/json'}
  }); }
  // 使用应用既有的逐文件授权函数；必须验证当前用户对该文件的权限。
  await assertCanReadMedia(user, mediaId);
  const {bytes, contentType} = await imaClient.download(mediaId, req.signal);
  return new Response(bytes, {headers:{...corsHeaders,'Content-Type':contentType}});
}
```
readPreviewRequest 从包内模块导入；imaClient 为 scripts/ima-client.mjs 的现有实例。corsHeaders 和 assertCanReadMedia 复用应用已有实现，这段是接线示例，不是独立鉴权服务。保留上游错误处理，不将错误响应作为200文件返回。不要接收客户端指定的下载地址/鉴权头。

## 保留与验收
- PDF 保留基线 PdfView 与匹配版本 worker；PNG 保留图片视图和对象URL清理。二者都不调用Office服务，也不等待正文提取。
- 下载按钮同样调用 fetchPreviewBlob，HTTP错误、JSON和空内容不得保存为原文件。
- 运行 node scripts/test-preview.mjs，覆盖双端字段、PDF/PNG原字节/MIME、非法ID与错误响应。
- 必须针对生成代码再测：同一请求通过实际handler到下载函数；400不得仅靠静态检查宣布修复。
- 离线测试通过仅表示契约通过；QA加载版本、真实文件、浏览器翻页/缩放/图片/下载仍分别验收。
- 本轮仅固化PDF/PNG公共传输修复；Word/PPT转换部署与扩展名、网页独立路由留待专项验证，不以修改其它已支持格式绕开。
