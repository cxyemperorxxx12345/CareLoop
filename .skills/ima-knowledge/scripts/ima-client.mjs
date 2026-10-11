// SERVER ONLY. Inject credentials from server environment; never bundle into frontend.
export function createImaClient({clientId, apiKey, fetchImpl = fetch}) {
  async function call(path, body, signal) {
    if (!clientId || !apiKey) throw new Error('IMA_NOT_CONFIGURED');
    const res = await fetchImpl(`https://ima.qq.com${path}`, {
      method:'POST', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000),
      headers:{'Content-Type':'application/json','ima-openapi-clientid':clientId,'ima-openapi-apikey':apiKey},
      body:JSON.stringify(body)
    });
    if (!res.ok) throw new Error(`IMA_HTTP_${res.status}`);
    const result = await res.json();
    if (result?.code !== 0 || !result.data || typeof result.data !== 'object') throw new Error(`IMA_PROTOCOL_OR_BUSINESS_${result?.code ?? 'missing'}`);
    return result.data;
  }
  const array = (data,key) => { if (!Array.isArray(data[key])) throw new Error(`IMA_MISSING_${key}`); return data[key]; };
  const media = (mediaId,signal) => call('/openapi/wiki/v1/get_media_info',{media_id:mediaId},signal);
  return {
    async listKb({query='',cursor='',limit=20}={},signal) {
      const d=await call('/openapi/wiki/v1/search_knowledge_base',{query,cursor,limit},signal);
      return {items:array(d,'info_list'),nextCursor:d.next_cursor ?? '',isEnd:d.is_end === true};
    },
    async listFiles({kbId,folderId,cursor='',limit=20},signal) {
      const d=await call('/openapi/wiki/v1/get_knowledge_list',{knowledge_base_id:kbId,...(folderId?{folder_id:folderId}:{}),cursor,limit},signal);
      return {items:array(d,'knowledge_list'),nextCursor:d.next_cursor ?? '',isEnd:d.is_end === true};
    },
    async metadata(mediaId,signal) {
      const d=await media(mediaId,signal);
      // Signed download headers remain server-side. Title is resolved from knowledge_list, not guessed here.
      return {mediaType:Number(d.media_type),notebookId:d.notebook_ext_info?.notebook_id};
    },
    note(noteId,signal) { return call('/openapi/note/v1/get_doc_content',{note_id:noteId,target_content_format:0},signal); },
    async download(mediaId,signal) {
      const d=await media(mediaId,signal);
      if (!d.url_info?.url) throw new Error('IMA_MEDIA_URL_MISSING');
      const res=await fetchImpl(d.url_info.url,{headers:d.url_info.headers ?? {},signal:signal ? AbortSignal.any([signal,AbortSignal.timeout(60000)]) : AbortSignal.timeout(60000)});
      if (!res.ok) throw new Error(`DOWNLOAD_HTTP_${res.status}`);
      const contentType=res.headers.get('content-type') || 'application/octet-stream';
      if (/application\/(?:[\w.-]+\+)?json/i.test(contentType)) throw new Error('DOWNLOAD_JSON');
      const bytes=await res.arrayBuffer();if(!bytes.byteLength) throw new Error('DOWNLOAD_EMPTY');
      return {bytes,contentType};
    }
  };
}
