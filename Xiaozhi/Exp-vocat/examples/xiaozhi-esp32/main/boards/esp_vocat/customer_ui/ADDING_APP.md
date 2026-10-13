# esp_vocat：如何新增 Customer UI 应用（给开发者 / AI）

本文描述在喵伴（`esp_vocat`）上新增一个可滑动切换的应用页面（类似「敲木鱼」「番茄钟」）的固定流程。后续改动请优先按此文档执行，不要另起一套导航框架。

## 架构（必读）

```
esp_vocat.cc
  └─ ui_bridge_init()              # 注册 HOME(DUMMY) 表情首页 + 手势
       └─ alarm_create_ui()        # 注册所有 customer 应用页
            └─ ui_bridge_register_page_with_cycle(page_id, &container, in_cycle)
```

| 层 | 路径 | 职责 |
|----|------|------|
| 桥接 | `../ui_bridge.cc` / `../ui_bridge.h` | 页面链表、显隐、边缘滑动；一般**不要改** |
| 注册中心 | `alarm_manager.cc` / `alarm_manager.h` | **必须改**：创建并注册新页 |
| 对外 API | `alarm_api.h` | 可选：给语音/底座调用 |
| 单页实现 | `alarm_<name>.cc` / `.h` | **新建**：LVGL UI + 逻辑 |

首页 ID：`UI_BRIDGE_PAGE_HOME` = `"DUMMY"`（表情层，不是 alarm 页）。

## 现有应用参考（按复杂度）

| 应用 | 文件 | 说明 |
|------|------|------|
| 木鱼/功德 | `alarm_muyu.cc` / `.h` | **最简模板**，点击计数 + 动画 |
| 番茄钟 | `alarm_pomodoro.cc` / `.h` | 计时、旋钮、EAF 动画（体积大） |
| 24h 闹钟 | `alarm_sleep_24h.*` | 另一套计时 UI |
| 结束页 | `alarm_end.*` | `in_cycle=false`，仅代码跳转 |

## 最少改动步骤（复制木鱼）

假设新应用名为 `demo`，页面 ID 为 `DEMO`。

### 1. 新建页面头文件 `alarm_demo.h`

```c
#pragma once
#include "lvgl.h"

#define PAGE_DEMO  "DEMO"

#ifdef __cplusplus
extern "C" {
#endif

lv_obj_t *alarm_demo_create_with_parent(lv_obj_t *parent);

#ifdef __cplusplus
}
#endif
```

### 2. 新建页面实现 `alarm_demo.cc`

要求：

- 在 `parent` 下创建全屏容器（尺寸用 `SCREEN_WIDTH` / `SCREEN_HEIGHT`，见 `alarm_manager.h`）
- 默认隐藏或交给 `ui_bridge` 管显隐（参考 `alarm_muyu.cc`）
- 返回该容器指针
- 控件事件、定时器写在本文件内

命名约定：

- 文件：`alarm_<name>.cc` / `.h`
- 工厂：`alarm_<name>_create_with_parent(lv_obj_t *parent)`
- 页面常量：`PAGE_<NAME>`，字符串唯一（如 `"DEMO"`）

### 3. 注册到 `alarm_manager`（必做）

**`alarm_manager.h`**

```c
#include "alarm_demo.h"
```

若使用内嵌图片/字体，在此集中 `LV_IMG_DECLARE` / `LV_FONT_DECLARE`（与 `muyu_white` 相同写法）。

**`alarm_manager.cc`**

```c
static lv_obj_t *container_demo = NULL;

void alarm_create_ui()
{
    // ... existing pages ...

    container_demo = alarm_demo_create_with_parent(scr);
    // true  = 参与边缘滑动循环
    // false = 只能 main_ui_switch_page() / ui_bridge_switch_page() 跳转
    ui_bridge_register_page_with_cycle(PAGE_DEMO, &container_demo, true);
}
```

### 4. 编译

`main/CMakeLists.txt` 对 `boards/${BOARD_TYPE}/**/*.cc` 使用 `GLOB_RECURSE`，**一般不用改 CMake**。

```bash
idf.py -DBOARD_NAME=esp_vocat -DBOARD_TYPE=esp_vocat build
```

## 可选接入

| 需求 | 改哪里 | 参考 |
|------|--------|------|
| 代码切页 | `main_ui_switch_page(PAGE_DEMO)` | `alarm_manager.cc` |
| 查当前页 | `ui_bridge_get_current_page()` | `ui_bridge.h` |
| 语音 / MCP | `../dev_tools.cc` 增加 tool，内部调 API | `self.pomodoro.*` |
| 底座敲击/磁吸 | `../base_control.cc` | 木鱼：当前页为 `PAGE_MUYU` 时 `lvgl_muyu_click()` |
| 稳定对外 C API | `alarm_api.h` + `alarm_manager.cc` | `alarm_start_pomodoro()` |
| 进入/离开页副作用 | `ui_bridge_set_page_switch_callback(...)` | `alarm_manager.cc` 里已注释的 CSI 示例 |

## 滑动顺序

- 手势：边缘左/下滑 → 上一页；右/上滑 → 下一页（细节见 `ui_bridge.cc`）。
- **注册顺序决定循环顺序**；后注册且 `in_cycle=true` 的页在循环中位置会变化。
- 改顺序：只调整 `alarm_create_ui()` 里 `ui_bridge_register_page_with_cycle` 的先后，不要改手势核心逻辑。

当前常见循环页（随注册变化，以代码为准）：`DUMMY` ↔ 番茄钟 / 睡眠 / 木鱼 等；`TIME_UP` 不在循环内。

## 资源放哪、体积会涨多少

| 资源类型 | 放置位置 | 影响 |
|----------|----------|------|
| 页面逻辑 | `alarm_*.cc` | **增大** `xiaozhi.bin`（app/ota），通常很小 |
| LVGL 内嵌图/字体 | `images/*.c`、`fonts/*.c` | **增大** app bin，一张图可达几十～几百 KB |
| 大动画 C 数组 | 如番茄钟 `clock_loop_eaf` | **显著增大** app（可达数百 KB） |
| 表情 / 可 OTA 资源 | `../assets/` → assets 分区 | 一般**不**算进主业务逻辑那几 KB，但占 Flash 另一分区 |

分区大致：`ota_0` ~6MB 固件，`assets` ~6MB。加「木鱼级」小页通常安全；加高清图/长动画前先 `idf.py size`。

图片生成：PNG → LVGL 转换器 → `.c`，放入 `images/`，并在 `alarm_manager.h` 声明。

## 不要做的事

- 不要新建第二套页面管理，绕过 `ui_bridge`。
- 不要把大资源硬编码进多个副本；共享声明放 `alarm_manager.h`。
- 不要改 `ui_bridge` 手势阈值，除非产品明确要求。
- 不要把新页只写在 SquareLine 导出目录却忘记在 `alarm_create_ui()` 注册（CSI 页当前是注释状态，启用需额外处理 `csi_ui` 链接）。

## AI 执行检查清单

新增应用完成后应满足：

- [ ] 存在 `alarm_<name>.h` / `.cc`，含唯一 `PAGE_*`
- [ ] `alarm_manager.h` 已 include
- [ ] `alarm_create_ui()` 已 create + `ui_bridge_register_page_with_cycle`
- [ ] 需要滑动则 `in_cycle=true`；仅弹层则 `false`
- [ ] 需要语音/底座则已接 `dev_tools.cc` / `base_control.cc`
- [ ] 未无故修改 `ui_bridge` 与 `CMakeLists.txt`
- [ ] 若加了内嵌图/动画，已评估 app 分区剩余空间

## 相关路径速查

```
examples/xiaozhi-esp32/main/boards/esp_vocat/
  ui_bridge.h / ui_bridge.cc
  esp_vocat.cc
  base_control.cc
  dev_tools.cc
  customer_ui/
    ADDING_APP.md          ← 本文件
    alarm_manager.cc       ← 注册中心
    alarm_api.h
    alarm_muyu.*           ← 最简参考
    alarm_pomodoro.*
    images/  fonts/
```
