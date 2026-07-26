# QQ Music + 小智 MCP 本地接入

基于 [QQ Music API](https://sansenjian.github.io/qq-music-api/) 与[小智 MCP 接入点说明](https://my.feishu.cn/wiki/HiPEwZ37XiitnwktX13cEM5KnSb) 的本地部署目录。

## 地址一览

| 服务 | 地址 |
|------|------|
| QQ Music HTTP API | `http://localhost:3200` |
| 音乐反代流 | `http://<MUSIC_PROXY_HOST>:3210/proxy/play?songmid=...` |
| API 在线文档 / 调试台 | https://sansenjian.github.io/qq-music-api/ |
| 小智 MCP 接入点 | 在 [xiaozhi.me](https://xiaozhi.me) 控制台获取（写入 `.env` 的 `MCP_ENDPOINT`） |

本地 `mcp_pipe.py` 把精简版 QQ 音乐 MCP（含缓存/取链）桥接到小智云端。

## 本地 MCP 工具

| 工具 | 说明 |
|------|------|
| `qq_music_search_songs` | 关键词搜歌（带缓存） |
| `qq_music_get_play_url` | 取 128kbps MP3 的 `cdn_url` + `proxy_url` |
| `qq_music_recent` | 本进程最近解析过的播放项 |
| `qq_music_auth_status` | 登录态摘要（不含完整 Cookie） |
| `qq_music_cache_stats` | 缓存命中与并发统计 |
| `qq_music_cache_clear` | 清空内存缓存 |

推荐语音侧顺序：`search_songs` → `get_play_url` →（二期）设备 `self.music.play_url`。

## 目录结构

```
qq-music-xiaozhi/
├── package.json
├── mcp_config.json          # 默认启用本地 cached MCP
├── config/                  # service-config + user-info(登录态)
├── scripts/ensure-login.mjs # 启动扫码登录
├── mcp/
│   ├── qq_music_local_mcp.mjs
│   ├── proxy-play.mjs
│   ├── lib/                 # cache / request / play manager
│   ├── mcp_pipe.py
│   └── requirements.txt
├── start.bat / stop.bat
└── .env.example
```

## 首次配置

```bat
copy .env.example .env
```

在 `.env` 填入小智 `MCP_ENDPOINT`。若设备要从局域网走反代，把 `MUSIC_PROXY_HOST` 改成电脑局域网 IP。

## 一键启动

```bat
start.bat
```

会启动：

1. QQ Music API `:3200`
2. Music Proxy `:3210`
3. Xiaozhi MCP Pipe（本地缓存 MCP）

Cookie 失效时自动弹扫码页。`SKIP_QQ_LOGIN=1` 可跳过。

## 手动验证

```bat
curl "http://localhost:3200/getRanks"
curl "http://localhost:3210/health"
curl -L "http://localhost:3210/proxy/play?songmid=你的songmid" -o test.mp3
```

小智控制台刷新 MCP，应看到上述精简工具；连续两次相同搜索第二次应为 cache hit。

## 参考

- QQ Music API：https://sansenjian.github.io/qq-music-api/
- 小智 MCP：https://my.feishu.cn/wiki/HiPEwZ37XiitnwktX13cEM5KnSb
- 示例：https://github.com/78/mcp-calculator
