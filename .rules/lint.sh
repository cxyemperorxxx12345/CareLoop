#!/bin/bash
# Composite lint runner.
# The five checks below are executed exactly as they were in package.json's
# original `lint` script -- same commands, same order, same arguments.
# This wrapper only observes them and prints a summary plus a final
# SUCCESS / ERROR marker. All steps always run; none is skipped on failure.

FAILED=""
SUMMARY=""

record() {
    local name="$1" ok="$2"
    if [ "$ok" -eq 0 ]; then
        SUMMARY="$SUMMARY$name: OK
"
    else
        SUMMARY="$SUMMARY$name: FAIL
"
        FAILED="$FAILED $name"
    fi
}

tsgo -p tsconfig.check.json
record "tsgo" $?

npx biome lint
record "biome" $?

# check.sh exits 0 even when ast-grep reports violations, so its status is
# derived from whether it produced any output rather than from its exit code.
CHECK_OUTPUT=$(.rules/check.sh 2>&1)
[ -n "$CHECK_OUTPUT" ] && echo "$CHECK_OUTPUT"
[ -z "$CHECK_OUTPUT" ]
record "check.sh" $?

# 本地开发：Git Bash 会把 /dev/null 传给原生 Windows 程序（node）后变成保留名 "nul"，
# 结果在项目根目录生成一个无法删除的 nul 文件，因此改为输出到临时目录再丢弃。
mkdir -p node_modules/.vite-temp
CSS_ERRORS=$(npx tailwindcss -i ./src/index.css -o node_modules/.vite-temp/tailwind-check.css 2>&1 | grep -E '^(CssSyntaxError|Error):.*')
[ -n "$CSS_ERRORS" ] && echo "$CSS_ERRORS"
[ -z "$CSS_ERRORS" ]
record "tailwind" $?

.rules/testBuild.sh
record "testBuild" $?

echo ""
echo "--------- LINT SUMMARY ---------"
printf '%s' "$SUMMARY"
echo "-------------------------------"
echo ""

if [ -n "$FAILED" ]; then
    echo "ERROR: lint failed ->$FAILED"
    exit 1
fi

echo "SUCCESS"
