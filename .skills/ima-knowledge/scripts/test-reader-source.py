"""Offline regression for source guard; not browser acceptance."""
import runpy
from pathlib import Path
check = runpy.run_path(str(Path(__file__).with_name('check-reader-source.py')))['findings']
auth_check = runpy.run_path(str(Path(__file__).with_name('check-reader-source.py')))['auth_contract_findings']
assert any('discards' in x for x in check('function WebLinkFallback({blob}) { void blob; return "嵌入策略限制"; }'))
assert any('placeholder' in x for x in check("if (route.preview === 'office-service') { setLoading(false); return; } <OfficePendingView />"))
assert not check("if (route.preview === 'office-service') { return <OfficeRenderer />; }")
assert not check('return <WebLinkView url={originalUrl} />;')
assert not check('const response = await fetch(endpoint); return await response.blob();')
print('PASS web discarded-payload and Office early-exit guards; valid branches retained. Offline only.')

assert any('placeholder' in x for x in check("case 'office-service': return <OfficePendingView fileName={name} />;"))
assert any('placeholder' in x for x in check("return ready ? <OfficeRenderer /> : <OfficePendingView />;"))
assert any('link-only' in x for x in check('export function WebLinkView() { return <a href={url}>打开原网页</a>; }'))
assert not check('export function WebLinkView() { return <iframe src={url} />; }')
print('PASS r9 switch/conditional Office placeholder and link-only webpage regression. Static only.')

import tempfile
with tempfile.TemporaryDirectory() as td:
    root = Path(td)
    (root/'src').mkdir(); (root/'supabase/functions/ima-reader').mkdir(parents=True)
    (root/'src/App.tsx').write_text("{/*<AuthProvider>*/} const route={public:true}; const token=session?.access_token || '';", encoding='utf-8')
    (root/'supabase/functions/ima-reader/index.ts').write_text("const {data}=await auth.getUser(token); const user=data.user; if (!user) return unauthorized;", encoding='utf-8')
    broken = auth_check(root)
    assert len(broken) == 2, broken
    (root/'src/App.tsx').write_text("const route={public:true}; const anonKey=env.ANON;", encoding='utf-8')
    (root/'supabase/functions/ima-reader/index.ts').write_text("const body=await request.json(); return fixedAction(body.action);", encoding='utf-8')
    assert auth_check(root) == []
print('PASS r10 public/login auth-contract mismatch regression. Static only.')

with tempfile.TemporaryDirectory() as td:
    root = Path(td)
    (root/'src').mkdir(); (root/'supabase/functions/ima-reader').mkdir(parents=True)
    f=root/'src/Reader.tsx'; b=root/'supabase/functions/ima-reader/index.ts'
    f.write_text('{error && <Alert/>} {loading ? <Spinner/> : kbs.length === 0 ? <Empty/> : <List/>}')
    b.write_text('const key=Deno.env.get("IMA_API_KEY"); return listKb(key);')
    result=auth_check(root)
    assert any('caller validation' in x for x in result),result
    assert any('empty state' in x for x in result),result
    f.write_text('{loading ? <Spinner/> : error ? <Error/> : kbs.length === 0 ? <Empty/> : <List/>}')
    b.write_text('const user=await authenticate(request); await requireFileAccess(user, mediaId); const key=Deno.env.get("IMA_API_KEY");')
    assert auth_check(root)==[]
print('PASS r13 private-credential caller gate and error/empty-state regression. Static only.')
