# 上游分析与实现选择

检出日期：2026-09-26；main HEAD `f9d1dba9a42714e32430dfc18e7ac317a6132f0c`。

| 目录 / 文件 | 职责 | 本次选择 |
| --- | --- | --- |
| README.md | Standalone 算法、蒸馏残局表、完整桌面版说明 | 阅读并区分轻量和 Mega Tablebase 路线 |
| backend/、backend_server.py | Python FastAPI 和桌面集成 | 不启动 |
| engine_core/ | 原应用的 Python 运行层 | 不依赖 |
| frontend/ | Vue 完整应用 | 不编译完整 GUI |
| native_core/src、include | C++ 引擎和生成器 | 保留完整源码 |
| native_core/egtb_data.7z | 预先生成的 egtb_data_256/512/1256 C++ 数据源压缩包，3,179,548 字节 | 已在现成 WASM 内，无需解压或生成 |
| docs/ai_core.js、ai_core.wasm | 发布的 Standalone 编译产物 | 原文件逐字节复制到 engine/ |
| docs/worker.js | L3Manager、CoreAILogic，残局匹配验证和动态搜索调度 | 由构建脚本原样提取；更换通信层 |
| docs/wasm_build/CMakeLists.txt | Emscripten C++17/O3/LTO 编译说明 | 用于核对 WASM 来源和资源配置 |

上游要求的 pywebview、NumPy、Python 原生模块、CMake、Meson、nanobind、OpenMP 等属于完整桌面/原生构建路线。本机现有 Python 3.8.10、MinGW GCC 8.1、Node.js 24.16；选用现有 Node 避免新装整套依赖。原版 WASM 在 V8 中正常加载和本地编译验证。

`scripts/build.mjs` 校验提取边界，复制编译产物，运行 WebAssembly.compile，并记录 Git 提交及 WASM/策略 SHA-256 到 `engine/manifest.json`。不自动更新上游，保证结果来源可追踪。

新增服务端负责标准游戏规则、随机出块、SQLite 数据、登录、调度和成绩；AI 工作线程只接收当前棋盘并返回推荐方向。游戏不会接受客户端提供的棋盘、分数或随机结果。引擎返回无效方向时暂停并报告错误，不悄悄替换成随机/弱 AI。

客户端是原生 HTML/CSS/JavaScript；没有前端框架、开发服务器、外部字体或 CDN。排行榜只接受服务端自然完赛数据；人工和 AI 混合的对局单独分类。批次统计以自然完赛局为分母，中止局单独保存。

已完成的自动化检查：规则 6 组 + API 综合流程；Chrome 桌面、375px 手机和横屏布局；键盘、单步、自动/暂停、刷新恢复、注册、批次控制、历史页面；无浏览器脚本错误。截图及 UI 报告保存在 test-results/。没有执行 100 或 1000 局完整强度统计。
