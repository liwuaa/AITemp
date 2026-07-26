# esp_vocat 喵伴

## 简介

<div align="center">
    <a href="https://oshwhub.com/esp-college/echoear"><b> 立创开源平台 </b></a>
</div>

esp_vocat 喵伴是一款智能 AI 开发套件，搭载 ESP32-S3-WROOM-1 模组，1.85 寸 QSPI 圆形触摸屏，双麦阵列，支持离线语音唤醒与声源定位算法。硬件详情等可查看[立创开源项目](https://oshwhub.com/esp-college/echoear)。

## 配置、编译命令

### 首次编译准备

**⚠️ 重要**: 首次编译前，需要在项目根目录运行以下命令生成默认配置文件：

```bash
python scripts/release.py esp_vocat
```

### 版本选择

esp_vocat 有两个硬件版本：
- **V1_0**（**当前本机强制使用**，见 `config.h` 中 `SELECT_BOARD`）
- **V1_2**

音频、底座 UART、头部触摸、LCD RST **全部**跟 `SELECT_BOARD` 走，禁止运行时混用。本机实测强制 V1.2 会导致喇叭/麦/底座/屏异常。

#### V1.0 引脚一览（当前默认）

| 功能 | 引脚 |
|------|------|
| I2S DIN | GPIO15 |
| PA | GPIO4 |
| 底座 UART TX/RX | GPIO6 / GPIO5 |
| 摸头触摸 | GPIO7（无 pad2，GPIO6 给 UART） |
| LCD RST | GPIO3（低有效） |

若确认为 V1.2 板，把 `SELECT_BOARD` 改成 `PCB_VERSION_V1_2` 后全量重编。

串口日志示例：

```text
SELECT_BOARD V1.0 pins: DIN=15 PA=4 UART TX=6 RX=5 LCD_RST=3 touch_pad2=disabled
Base UART init: Port=1 Baud=115200 TX=6 RX=5 (SELECT_BOARD V1.0)
```

I2C 总线使用 `I2C_NUM_1`（与 `BoxAudioCodec` / 触摸同口）。

### 配置编译目标为 ESP32S3

```bash
idf.py set-target esp32s3
```

### 打开 menuconfig 并配置

```bash
idf.py menuconfig
```

分别配置如下选项：

#### 基本配置
- `Xiaozhi Assistant` → `Board Type` → 选择 `esp_vocat`

### UI风格选择

esp_vocat 支持多种不同的 UI 显示风格，通过 menuconfig 配置选择：

- `Xiaozhi Assistant` → `Select display style` → 选择显示风格

#### 可选风格

##### 表情资源模式 (Expression assets mode) - 默认
- **配置选项**: `CONFIG_FLASH_EXPRESSION_ASSETS=y`
- **特点**: 从 `esp_emote_assets` 生成资源文件
- **功能**: 使用自定义资源文件，资源文件位置为 `boards/esp_vocat/assets` 目录
- **适用**: 带底座固件的默认模式
- **类**: `emote::EmoteDisplay`

##### 表情动画风格 (Emote animation style) - 推荐
- **配置选项**: `USE_EMOTE_MESSAGE_STYLE`
- **特点**: 使用自定义的 `EmoteDisplay` 表情显示系统
- **功能**: 支持丰富的表情动画、眼睛动画、状态图标显示
- **适用**: 智能助手场景，提供更生动的人机交互体验
- **类**: `emote::EmoteDisplay`

**⚠️ 重要**: 选择此风格需要额外配置自定义资源文件：
1. `Xiaozhi Assistant` → `Flash Assets` → 选择 `Flash Custom Assets`
2. `Xiaozhi Assistant` → `Custom Assets File` → 填入资源文件地址：
   ```
   https://dl.espressif.com/AE/wn9_nihaoxiaozhi_tts-font_puhui_common_20_4-echoear.bin
   ```

##### 默认消息风格 (Enable default message style)
- **配置选项**: `USE_DEFAULT_MESSAGE_STYLE` (默认)
- **特点**: 使用标准的消息显示界面
- **功能**: 传统的文本和图标显示界面
- **适用**: 标准的对话场景
- **类**: `SpiLcdDisplay`

##### 微信消息风格 (Enable WeChat Message Style)
- **配置选项**: `USE_WECHAT_MESSAGE_STYLE`
- **特点**: 仿微信聊天界面风格
- **功能**: 类似微信的消息气泡显示
- **适用**: 喜欢微信风格的用户
- **类**: `SpiLcdDisplay`

> **说明**: esp_vocat 使用16MB Flash，需要使用专门的分区表配置来合理分配存储空间给应用程序、OTA更新、资源文件等。

按 `S` 保存，按 `Q` 退出。

**编译**

推荐（板型参数 + Windows 控制台 UTF-8，避免资源脚本打印 `✓` 时 GBK 报错）：

```bash
# PowerShell：先进入对应 IDF 环境（如桌面 IDF_v5.5.5_Powershell.lnk）
$env:PYTHONIOENCODING='utf-8'; $env:PYTHONUTF8='1'
idf.py -DBOARD_NAME=esp_vocat -DBOARD_TYPE=esp_vocat build
```

或：

```bash
python scripts/release.py esp_vocat
```

**烧录**

将 esp_vocat 连接至电脑，**注意打开电源**，并确认串口是本机的 ESP32-S3（勿烧到其它芯片的 COM 口），然后：

```bash
idf.py -p COMx flash
```

### 编译故障排查（ESP-IDF 5.5.x / Windows）

1. **链接报错 `dangerous relocation: call8: call target out of range`（`phy_common.c` / `esp_timer_get_time` 等）**  
   多为 `esp_phy` 的 `phy_common.c.obj` 被缓存成未带 `-mlongcalls` 的坏对象。处理：

   ```bash
   # 删坏对象后重编，或直接全清
   idf.py fullclean
   # 可选：关闭 ccache 再编
   # PowerShell: $env:IDF_CCACHE_ENABLE='0'
   idf.py -DBOARD_NAME=esp_vocat -DBOARD_TYPE=esp_vocat build
   ```

   正常对象应含 `callx8`；坏对象只有短程 `call8`，固件一大就会链不过。

2. **`UnicodeEncodeError: 'gbk' ...`**  
   设置 `PYTHONUTF8=1` / `PYTHONIOENCODING=utf-8`，或 `chcp 65001`。

3. **`Access is denied` 删除 `.obj.d`**  
   残留 `ninja` 占用文件：结束相关 `ninja`/`python` 进程后再编。

4. **喇叭无声 / 麦克风无效 / 底座无通信 / 花屏**  
   确认日志 `SELECT_BOARD V1.x pins` 与实物一致；本机请用 V1.0。错误版本会把 PA/UART/LCD RST 接到错误 GPIO。

## 新增应用（Customer UI）

如何在滑动页面体系里加新应用（木鱼/番茄钟同款），见：

[`customer_ui/ADDING_APP.md`](customer_ui/ADDING_APP.md)

（给开发者与 AI：注册入口、文件模板、体积影响、检查清单。）

## 功能使用说明

### 1. DOA 声音方向跟随模式

- **默认状态**: 上电默认使能该功能
- **功能**: 头部可跟随声音方向转动
- **语音控制**: 说 "doa_follow" 或 "DOA 声音方向跟随模式" 来启用

### 2. 鼓点检测模式

- **功能**: 头部可跟随音乐鼓点节拍摇动
- **切换方式**: 通过语音切换
- **语音控制**: 说 "beat_detection" 或 "鼓点检测模式，跟着音乐跳舞"

### 3. 番茄钟模式

- **启动方式**:
  - 待机表情首页**左滑**或**下滑**自动启动
  - 默认时间: 5 分钟
  - 可手动调节时间

- **操作说明**:
  - **单击**番茄钟中间位置：暂停/恢复运行
  - 时间结束后，自动跳转到结束界面
  - 结束界面可选择：
    - 继续 5 分钟
    - 滑动结束回到待机首页

- **语音控制**:
  - "帮我开始（1-60分钟）番茄闹钟" - 设置指定时长的番茄钟
  - "暂停番茄钟" - 暂停运行中的番茄钟
  - "启动番茄钟" - 恢复暂停的番茄钟

### 4. 24 小时时钟模式

- **启动方式**: 待机表情首页**右滑**或**上滑**进入
- **时间设置**:
  - 起始时间：自动设置为当前时间
  - 结束时间：可手动调节
- **显示模式切换**: **单击**时钟中间界面，可在以下两种模式间切换：
  - `xx:xx - xx:xx` (时间范围显示)
  - `xx hr` (时长显示)
- **语音控制**: "帮我开启一个几点几分的闹钟" (例如："帮我开启一个8点30分的闹钟")

### 5. 语音唤醒功能

支持以下 4 种唤醒方式：

1. **移动底座脖子位置磁吸开关** - 物理唤醒
2. **语音唤醒** - 说 "你好喵伴"
3. **单击待机界面屏幕** - 触摸唤醒
4. **头部触摸 1.2 秒** - 长按触摸，会向服务器发送摸头事件

### 6. 底座校准

- **手动校准**:
  - **长按**底座 BOOT 按键，触发磁吸按钮校准功能
  - UI 会依次提示：
    - "步骤1：将磁吸按钮反方向移动"
    - "步骤2：取下磁吸按钮"

- **语音校准**: 说 "校准底座"