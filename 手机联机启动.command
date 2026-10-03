#!/bin/bash
# 手机联机启动器：让同一 Wi-Fi 下的手机 / 平板也能打开游戏
# （启动.command 只监听本机 127.0.0.1，手机连不进来；这个脚本对局域网开放）

cd "$(dirname "$0")" || exit 1
PORT=5174

IP=$(ipconfig getifaddr en0 || ipconfig getifaddr en1)
if [ -z "$IP" ]; then
  echo "没找到局域网 IP（没连 Wi-Fi？），先用电脑玩：双击 启动.command"
  exit 1
fi

echo "正在启动局域网服务…"
python3 -c "
import http.server, mimetypes
mimetypes.add_type('audio/flac', '.flac')
mimetypes.add_type('audio/ogg', '.ogg')
mimetypes.add_type('audio/ogg', '.opus')
mimetypes.add_type('audio/mpeg', '.mp3')
srv = http.server.ThreadingHTTPServer(('0.0.0.0', $PORT), http.server.SimpleHTTPRequestHandler)
srv.serve_forever()
" >/dev/null 2>&1 &
sleep 1

open "http://127.0.0.1:$PORT/"
echo ""
echo "✅ 电脑上玩：    http://127.0.0.1:$PORT/"
echo "📱 手机上玩：    http://$IP:$PORT/   （手机连同一个 Wi-Fi，用相机或浏览器打开）"
echo ""
echo "玩完直接关掉这个窗口就行。"
wait
