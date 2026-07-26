#include "base_control.h"
#include "esp_vocat.h"
#include "vocat_base_control.h"
#include "display/display.h"
#include "display/emote_display.h"
#include "config.h"
#include "application.h"
#include "assets/lang_config.h"
#include "device_state.h"
#include <esp_log.h>
#include <esp_timer.h>
#include "customer_ui/alarm_manager.h"
#include "customer_ui/alarm_api.h"

#define TAG "BaseControl"

const char *current_page = nullptr;

static void lvgl_muyu_click_cb(void *arg)
{
    (void)arg;
    lvgl_muyu_click();
}

BaseControl::BaseControl(EspS3Cat* board) : board_(board)
{
    vocat_base_online_ = false;
    last_heartbeat_time_ = 0;
    offline_since_ms_ = 0;
    heartbeat_check_timer_ = nullptr;
    calibrate_semaphore_ = xSemaphoreCreateBinary();

    if (calibrate_semaphore_ == nullptr) {
        ESP_LOGE(TAG, "Failed to create calibrate semaphore");
    }
}

BaseControl::~BaseControl()
{
    if (heartbeat_check_timer_ != nullptr) {
        esp_timer_stop(heartbeat_check_timer_);
        esp_timer_delete(heartbeat_check_timer_);
    }
    if (calibrate_semaphore_ != nullptr) {
        vSemaphoreDelete(calibrate_semaphore_);
    }
}

void BaseControl::Initialize()
{
    ESP_LOGI(TAG, "Base UART init: Port=1 Baud=115200 TX=%d RX=%d (SELECT_BOARD V1.%d)",
             (int)UART1_TX, (int)UART1_RX,
             SELECT_BOARD == PCB_VERSION_V1_0 ? 0 : 2);

    vocat_base_control_config_t base_config = {
        .uart_num = UART_NUM_1,
        .tx_pin = UART1_TX,
        .rx_pin = UART1_RX,
        .baud_rate = 115200,
        .rx_buffer_size = 1024,
        .cmd_cb = CmdCallback,
        .user_ctx = this,
    };
    esp_err_t ret = vocat_base_control_init(&base_config);
    if (ret != ESP_OK) {
        ESP_LOGE(TAG, "Failed to initialize echo base control");
        return;
    }

    // Initialize heartbeat monitoring timer
    const esp_timer_create_args_t heartbeat_timer_args = {
        .callback = &HeartbeatCheckTimerCallback,
        .arg = this,
        .name = "heartbeat_check"
    };
    ret = esp_timer_create(&heartbeat_timer_args, &heartbeat_check_timer_);
    if (ret != ESP_OK) {
        ESP_LOGE(TAG, "Failed to create heartbeat check timer");
        return;
    }

    // Start periodic timer to check heartbeat every 500ms
    ret = esp_timer_start_periodic(heartbeat_check_timer_, 500 * 1000);  // 500ms in microseconds
    if (ret != ESP_OK) {
        ESP_LOGE(TAG, "Failed to start heartbeat check timer");
        esp_timer_delete(heartbeat_check_timer_);
        heartbeat_check_timer_ = nullptr;
        return;
    }

    // Initialize to offline state
    vocat_base_online_ = false;
    last_heartbeat_time_ = 0;
    offline_since_ms_ = 0;
}

void BaseControl::HandleCommand(uint8_t cmd, uint8_t *data, int data_len)
{
    Display* display = board_->GetDisplay();
    if (display == nullptr) {
        return;
    }

    emote::EmoteDisplay* emote_display = dynamic_cast<emote::EmoteDisplay*>(display);

    if (cmd != VOCAT_BASE_CMD_RECV_HEARTBEAT) {
        printf("Handle: cmd=%02X, ", cmd);
        for (int i = 0; i < data_len; i++) {
            printf("%02X ", data[i]);
        }
        printf("\n");
    }

    switch (cmd) {
    case VOCAT_BASE_CMD_RECV_SLIDE_SWITCH: {
        if (data_len >= 2) {
            auto &app = Application::GetInstance();

            uint16_t event = (data[0] << 8) | data[1];
            switch (event) {
            case VOCAT_BASE_CMD_RECV_SWITCH_SLIDE_DOWN:
                ESP_LOGI(TAG, "Slide switch down");
                app.ToggleChatState();
                break;
            case VOCAT_BASE_CMD_RECV_SWITCH_SLIDE_UP:
                ESP_LOGI(TAG, "Slide switch up");
                current_page = ui_bridge_get_current_page();
                if(strcmp(current_page, PAGE_POMODORO) == 0) {
                    alarm_start_pomodoro(5);
                    ESP_LOGI(TAG, "Restart POMODORO");
                }else{
                app.ToggleChatState();}
                break;
            case VOCAT_BASE_CMD_RECV_SWITCH_SINGLE_CLICK:
                ESP_LOGI(TAG, "Single click");
                current_page = ui_bridge_get_current_page();
                if (strcmp(current_page, PAGE_MUYU) == 0) {
                    lv_async_call(lvgl_muyu_click_cb, nullptr);
                    ESP_LOGI(TAG, "Set MAIN_EVENT_PLAY_MUYU");
                }
                break;
            case VOCAT_BASE_CMD_RECV_CALIBRATE_START:
                ESP_LOGI(TAG, "Calibrate start");
                display->SetChatMessage("system", Lang::Strings::CALIBRATING_STEP1);
                break;
            case VOCAT_BASE_CMD_RECV_CALIBRATE_STEP1:
                ESP_LOGI(TAG, "Calibrate step 1 Done");
                display->SetChatMessage("system", Lang::Strings::CALIBRATING_STEP2);
                break;
            case VOCAT_BASE_CMD_RECV_CALIBRATE_STEP2:
                ESP_LOGI(TAG, "Calibrate step 2 Done");
                display->SetChatMessage("system", Lang::Strings::CALIBRATING_STEP3);
                if (calibrate_semaphore_ != nullptr) {
                    xSemaphoreGive(calibrate_semaphore_);
                }
                break;
            case VOCAT_BASE_CMD_RECV_SWITCH_FISH_ATTACHED:
                ESP_LOGI(TAG, "Fish attached");
                if (emote_display != nullptr) {
                    emote_display->InsertAnimDialog("eat", 3500);
                }
                break;
            case VOCAT_BASE_CMD_RECV_SWITCH_PAIR_DETECT:
                ESP_LOGI(TAG, "Pair detect");
                if (emote_display != nullptr) {
                    emote_display->SetEmotion("happy");
                }
                vocat_base_control_set_action(VOCAT_BASE_CMD_SET_ACTION_LOOK_AROUND);
                break;
            default:
                ESP_LOGI(TAG, "Slide switch event: %d", event);
                break;
            }
        }
        break;
    }
    case VOCAT_BASE_CMD_RECV_PERCEPTION: {
        ESP_LOGI(TAG, "Perception mode response, data_len=%d", data_len);
        break;
    }
    case VOCAT_BASE_CMD_RECV_ACTION: {
        ESP_LOGI(TAG, "Action response, data_len=%d", data_len);
        uint16_t event = (data[0] << 8) | data[1];
        switch (event) {
        case VOCAT_BASE_CMD_RECV_ACTION_DONE:
            ESP_LOGI(TAG, "Action done");
            break;
        default:
            ESP_LOGI(TAG, "Unknown action event: %d", event);
            break;
        }
        break;
    }
    case VOCAT_BASE_CMD_RECV_HEARTBEAT: {
        uint16_t event = (data_len >= 2) ? ((data[0] << 8) | data[1]) : 0;
        switch (event) {
        case VOCAT_BASE_CMD_RECV_HEARTBEAT_ALIVE: {
            int64_t current_time = esp_timer_get_time() / 1000;  // Convert to milliseconds
            bool was_offline = !vocat_base_online_;
            int64_t offline_ms = 0;
            if (was_offline && offline_since_ms_ > 0) {
                offline_ms = current_time - offline_since_ms_;
            }

            last_heartbeat_time_ = current_time;
            vocat_base_online_ = true;
            offline_since_ms_ = 0;

            if (was_offline) {
                // Brief UART glitches while the base is moving must not spam insert anim.
                if (offline_ms >= REINSERT_ANIM_MIN_OFFLINE_MS) {
                    ESP_LOGI(TAG, "Echo base reinserted after %ld ms offline", (long)offline_ms);
                    if (emote_display != nullptr) {
                        emote_display->InsertAnimDialog("insert", 3000);
                    }
                } else {
                    ESP_LOGI(TAG, "Echo base online (offline was %ld ms, skip insert anim)",
                             (long)offline_ms);
                }
            }
            break;
        }
        }
        break;
    }
    default: {
        ESP_LOGI(TAG, "Unknown command: 0x%02X", cmd);
        break;
    }
    }
}

void BaseControl::HeartbeatCheckTimerCallback(void* arg)
{
    BaseControl* self = static_cast<BaseControl*>(arg);
    if (self == nullptr) {
        return;
    }

    // Skip check if we haven't received any heartbeat yet
    if (self->last_heartbeat_time_ == 0) {
        return;
    }

    int64_t current_time = esp_timer_get_time() / 1000;  // Convert to milliseconds
    int64_t time_since_last_heartbeat = current_time - self->last_heartbeat_time_;

    if (self->vocat_base_online_ && time_since_last_heartbeat > BaseControl::HEARTBEAT_TIMEOUT_MS) {
        self->vocat_base_online_ = false;
        self->offline_since_ms_ = current_time;
        ESP_LOGW(TAG, "Echo base disconnected (timeout: %ld ms)", (long)time_since_last_heartbeat);
    }
}

bool BaseControl::WaitForCalibrationComplete(int timeout_ms)
{
    if (calibrate_semaphore_ == nullptr) {
        ESP_LOGE(TAG, "Calibrate semaphore not initialized");
        return false;
    }

    // Clear semaphore first in case it was already set
    xSemaphoreTake(calibrate_semaphore_, 0);

    // Wait for calibration to complete
    TickType_t timeout_ticks = pdMS_TO_TICKS(timeout_ms);
    BaseType_t result = xSemaphoreTake(calibrate_semaphore_, timeout_ticks);

    if (result == pdTRUE) {
        ESP_LOGI(TAG, "Calibration completed successfully");
        return true;
    } else {
        ESP_LOGW(TAG, "Calibration wait timeout after %d ms", timeout_ms);
        return false;
    }
}

void BaseControl::CmdCallback(uint8_t cmd, uint8_t *data, int data_len, void *user_ctx)
{
    BaseControl* self = static_cast<BaseControl*>(user_ctx);
    if (self != nullptr) {
        self->HandleCommand(cmd, data, data_len);
    }
}
