#!/bin/bash

# 本地开发：ast-grep 不在 package.json 依赖里（Miaoda 沙箱预装）。
# 已装到项目内 .toolchain/，找不到全局命令时回退到该路径。
_RULES_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if ! command -v ast-grep >/dev/null 2>&1; then
    _SG_BIN="$_RULES_DIR/../.toolchain/node_modules/.bin"
    # MSYS/Git Bash 的 PATH 以 : 分隔，含盘符的 "Y:/..." 会被截断解析，必须转成 "/y/..."
    command -v cygpath >/dev/null 2>&1 && _SG_BIN="$(cygpath -u "$_SG_BIN")"
    export PATH="$_SG_BIN:$PATH"
fi

ast-grep scan -r .rules/SelectItem.yml

ast-grep scan -r .rules/contrast.yml

ast-grep scan -r .rules/supabase-google-sso.yml

ast-grep scan -r .rules/toast-hook.yml

ast-grep scan -r .rules/slot-nesting.yml

ast-grep scan -r .rules/require-button-interaction.yml

ast-grep scan -r .rules/supabase-edge-function-get-body.yml

ast-grep scan -r .rules/no-csp-meta.yml

useauth_output=$(ast-grep scan -r .rules/useAuth.yml 2>/dev/null)

if [ -z "$useauth_output" ]; then
    exit 0
fi

authprovider_output=$(ast-grep scan -r .rules/authProvider.yml 2>/dev/null)

if [ -n "$authprovider_output" ]; then
    exit 0
fi

echo "=== ast-grep scan -r .rules/useAuth.yml output ==="
echo "$useauth_output"
echo ""
echo "=== ast-grep scan -r .rules/authProvider.yml output ==="
echo "$authprovider_output"
echo ""
echo "⚠️  Issue detected:"
echo "The code uses useAuth Hook but does not have AuthProvider component wrapping the components."
echo "Please ensure that components using useAuth are wrapped with AuthProvider to provide proper authentication context."
echo ""
echo "Suggested fixes:"
echo "1. Add AuthProvider wrapper in app.tsx or corresponding root component"
echo "2. Ensure all components using useAuth are within AuthProvider scope"
