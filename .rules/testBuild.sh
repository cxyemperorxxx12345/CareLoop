#!/bin/bash

VITE_TEMP="node_modules/.vite-temp"
if [ -L "$VITE_TEMP" ]; then
    rm "$VITE_TEMP"
    mkdir -p "$VITE_TEMP"
elif [ ! -e "$VITE_TEMP" ]; then
    mkdir -p "$VITE_TEMP"
fi

# 本地开发：原输出目录 /workspace/.dist 是 Miaoda 沙箱专用路径，Windows/macOS 不存在，
# 改为项目内的 node_modules/.vite-temp/dist（已被 .gitignore 忽略）。
OUTPUT=$(npx vite build --minify false --logLevel error --outDir node_modules/.vite-temp/dist 2>&1)
EXIT_CODE=$?

if [ $EXIT_CODE -ne 0 ]; then
    echo "$OUTPUT"
fi

exit $EXIT_CODE
