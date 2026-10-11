#!/usr/bin/env python3
"""Known-pattern guard only; does not certify parsing correctness."""
import re, sys
from pathlib import Path

def findings(text, server=False):
    rules = [
      (r'new\s+TextDecoder\(\s*[\"\'](?:latin1|iso-8859-1)[\"\']', 'Review latin1 decoder: forbidden as PDF file parser'),
      (r'(?:async\s+)?function\s+(?:unzip|inflateRaw|extractPdfText|decodePdfString)\s*\(', 'Handwritten archive/PDF parser: replace with verified library'),
      (r'getUint32\([^\n]*true\)[\s\S]{0,120}0x04034b50', 'Manual ZIP local-header traversal'),
      (r'return\s+data\s+as\s+ArrayBuffer', 'Type assertion is not binary conversion'),
    ]
    if re.search(r'invoke\s*<ArrayBuffer>', text) and re.search(r'return\s+data\s*;', text):
        rules.append((r'invoke\s*<ArrayBuffer>', 'SDK generic plus raw return: normalize actual bytes or use raw Response'))
    if re.search(r'kind\s*!==\s*[\"\']pdf[\"\']\s*&&\s*kind\s*!==\s*[\"\']image', text):
        rules.append((r'kind\s*!==', 'Non-PDF/image blanket rejection: implement format views and Office capability gate'))
    if server and '/agent-interface/' in text:
        rules.append((r'/agent-interface/', 'Invalid business API prefix; use /openapi/wiki/v1 or /openapi/note/v1'))
    if server and re.search(r'["\'](?:client_id|api_key)["\']\s*:\s*creds\.', text):
        rules.append((r'creds\.', 'Wrong ima auth headers; use ima-openapi-clientid/apikey'))
    if 'Blob' in text and re.search(r'return new Uint8Array\(0\)',text):
        rules.append((r'return new Uint8Array\(0\)', 'Blob converted to empty bytes instead of awaited arrayBuffer'))
    if 'supabase.functions.invoke' in text and 'new Response(data)' in text:
        rules.append((r'new Response\(data\)', 'Reconstructed Response is not original transport; inspect SDK decoding'))
    if 'isMarkdown={mediaType === 13}' in text:
        rules.append((r'isMarkdown=', 'Markdown is media_type 7; 13 is TXT'))
    if re.search(r'functions\.invoke', text) and re.search(r'instanceof\s+Blob', text):
        rules.append((r'instanceof\s+Blob', 'Review SDK + Blob gate: original files must use native fetch, not MIME-decoded invoke data'))
    if re.search(r'void\s+blob\s*;', text) and '嵌入策略' in text:
        rules.append((r'void\s+blob', 'Web preview discards payload and hardcodes embed restriction'))
    if re.search(r'<OfficePendingView\b', text):
        rules.append((r'<OfficePendingView\b', 'Office placeholder mounted: requires manual renderer evidence; not preview delivery'))
    if re.search(r'export\s+function\s+WebLinkView\b', text) and not re.search(r'<iframe\b|<WebPreview\b|<WebSnapshot\b', text):
        rules.append((r'WebLinkView', 'Web link-only component: not inline webpage preview'))
    result = [message for pattern,message in rules if re.search(pattern,text,re.I)]
    if server and re.search(r"new\s+DOMParser\s*\(", text):
        result.append("Server DOMParser dependency: use explicit verified XML implementation")
    if server and re.search(r"const\s*\{\s*url\s*,\s*headers\s*\}\s*=\s*body", text):
        result.append("Client supplied download URL/headers: replace with authorized mediaId resolution")
    return result

def auth_contract_findings(root):
    """Catch the demonstrated public-page + mandatory-user-session mismatch."""
    texts = {}
    for p in root.rglob('*'):
        if p.is_file() and p.suffix in {'.ts', '.tsx', '.js', '.mjs'}:
            if any(x in {'node_modules', '.git', 'dist', 'build'} for x in p.relative_to(root).parts):
                continue
            texts[p.relative_to(root).as_posix()] = p.read_text(errors='replace')
    frontend = '\n'.join(v for k, v in texts.items() if k.startswith('src/'))
    server = '\n'.join(v for k, v in texts.items() if 'supabase/functions/' in k)
    public_routes = bool(re.search(r'public\s*:\s*true', frontend))
    auth_provider_disabled = bool(re.search(r'\{\s*/\*\s*<AuthProvider', frontend)) or '<AuthProvider' not in frontend
    mandatory_user = bool(re.search(r'getUser\s*\(', server) and re.search(r'if\s*\(\s*!user\s*\)', server))
    empty_session_bearer = bool(re.search(r'access_token\s*\|\|\s*["\']["\']', frontend))
    result = []
    if public_routes and auth_provider_disabled and mandatory_user:
        result.append('Public routes/AuthProvider disabled but Edge Function mandates getUser session: wire login and authorized access end-to-end; do not remove user checks to silence 401')
    if public_routes and auth_provider_disabled and empty_session_bearer:
        result.append('Public app constructs Bearer from an optional empty session: implement login/session handling; anon key alone does not authorize private ima access')
    shared_ima_secret = bool(re.search(r'Deno\.env\.get\(["\']IMA_API_KEY["\']\)', server))
    user_validation = bool(re.search(r'getUser\s*\(|authenticate\s*\(|verifyJwt\s*\(', server))
    if shared_ima_secret and not user_validation:
        result.append('Private ima credentials without visible caller validation: require identity and per-file authorization evidence; public sharing needs explicit scoped approval')
    if re.search(r'error\s*&&', frontend) and re.search(r':\s*kbs\.length\s*===\s*0\s*\?', frontend):
        result.append('Knowledge-base failure also renders empty state: gate empty view on successful request')
    return result

def main():
    if len(sys.argv)!=2 or not Path(sys.argv[1]).is_dir():
        print('Usage: check-reader-source.py APP_SOURCE_DIRECTORY'); return 2
    root=Path(sys.argv[1]); checked=0; failed=0
    for p in sorted(root.rglob('*')):
        if any(x in {'node_modules','.git','dist','build'} for x in p.relative_to(root).parts): continue
        if not p.is_file() or p.suffix not in {'.ts','.tsx','.js','.mjs'}: continue
        checked+=1
        for message in findings(p.read_text(errors='replace'), server="supabase/functions" in p.as_posix()):
            print(f'FAIL {p.relative_to(root)}: {message}'); failed+=1
    for message in auth_contract_findings(root):
        print(f'FAIL auth-contract: {message}'); failed += 1
    if not checked: print('FAIL no source files'); return 2
    print(f'Checked {checked} files; findings={failed}; runtime/visual acceptance still required')
    return 1 if failed else 0
if __name__=='__main__': sys.exit(main())
