#!/bin/bash

echo "========================================"
echo "o1key 图片生成器 - 一键启动"
echo "========================================"
echo ""

# 检查系统 Python 是否存在
if ! command -v python3 &> /dev/null; then
    echo "错误: 未找到 Python 3！"
    echo "请安装 Python 3.7+ 后再运行。"
    echo ""
    exit 1
fi

# 检查虚拟环境是否存在
if [ ! -f "app/venv/bin/python" ]; then
    echo "错误: 虚拟环境不存在！"
    echo "请确保 app/venv 文件夹完整，或重新解压安装包。"
    echo ""
    exit 1
fi

# 直接使用虚拟环境的 Python 启动
echo "启动服务器..."
echo "访问地址: http://localhost:8080/home.html"
echo ""
echo "按 Ctrl+C 停止服务器"
echo "========================================"
echo ""

app/venv/bin/python app/server.py
