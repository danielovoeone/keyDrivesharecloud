#!/bin/bash
# 双击运行：启动 KeyDriveShareCloud 并开启公网访问
# 前提：已安装 cloudflared（终端里执行 brew install cloudflared）
cd "$(dirname "$0")" || exit 1

if ! command -v cloudflared >/dev/null 2>&1; then
  echo "未检测到 cloudflared，请先在终端执行：brew install cloudflared"
  printf "按回车键关闭…"; read -r
  exit 1
fi

# 网站本体没跑就先拉起来
if ! curl -s -o /dev/null --max-time 1 http://localhost:3000/; then
  echo "启动本地服务…"
  node server.js &
  sleep 1
fi

echo "正在开启公网隧道（约需几秒）…"
LOG="$(mktemp)"
cloudflared tunnel --url http://localhost:3000 2>&1 | tee "$LOG" >/dev/null &
sleep 7

URL="$(grep -m1 -o 'https://[a-z0-9-]*\.trycloudflare\.com' "$LOG")"
echo ""
if [ -n "$URL" ]; then
  echo "  ✅ 公网网址（发给朋友即可访问）："
  echo ""
  echo "      $URL"
  echo ""
  echo "  注意：网址在每次重新运行后都会变化；关闭本窗口即停止公网访问。"
  open "$URL" 2>/dev/null
else
  echo "  ❌ 未获取到公网网址，请检查网络后重试（日志：$LOG）"
fi
printf "按回车键停止公网访问并关闭…"; read -r
kill 0 2>/dev/null
