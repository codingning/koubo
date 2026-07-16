# 渠道健康记录｜2026-07-15

- 检查时间：2026-07-15 17:41:38 +08:00
- Agent Reach：已执行，详见 raw/agent_reach_doctor.json
- OpenCLI：已执行，详见 raw/opencli_doctor.txt
- 小红书推荐流：已执行，详见 raw/xiaohongshu_feed.yaml
- 小红书搜索：AI 新规：已执行，详见 raw/xiaohongshu_search_01_AI_新规.yaml
- 小红书搜索：AI 产品更新：已执行，详见 raw/xiaohongshu_search_02_AI_产品更新.yaml
- 小红书搜索：新能源车：已执行，详见 raw/xiaohongshu_search_03_新能源车.yaml
- 小红书搜索：网号 网证：已执行，详见 raw/xiaohongshu_search_04_网号_网证.yaml
- 小红书搜索：人形机器人：已执行，详见 raw/xiaohongshu_search_05_人形机器人.yaml
- 小红书搜索：职场 趋势：已执行，详见 raw/xiaohongshu_search_06_职场_趋势.yaml
- RSS：已执行，详见 raw/rss_collect.log
- 抖音：需由浏览器读取官方热榜；官方关键词搜索未登录时会要求扫码。
- 微博：先试官方热搜；若进入 Visitor System，使用 zhaoyizhe.com 聚合榜并标为热度信号。
- 通用网页：Jina 当前实测超时；使用内置网页搜索或浏览器。
- Exa：当前 mcporter 读取 mcp.json 报 EPERM，不阻塞主流程。

## 浏览器与榜单补充实测

- 浏览器：Codex In-app Browser 可用。
- 抖音官方热榜：可读取榜单标题、链接与热度；主选题约913.7万热度。
- 抖音关键词搜索：未登录状态要求扫码，按降级规则不阻塞。
- 微博官方热搜：进入 Sina Visitor System，无法直接读取。
- 微博降级源：zhaoyizhe.com 可读取当前公开聚合榜；仅作为热度信号。
- 微博关键词历史搜索：未登录时提示登录，无法确认主选题完整微博讨论强度。
