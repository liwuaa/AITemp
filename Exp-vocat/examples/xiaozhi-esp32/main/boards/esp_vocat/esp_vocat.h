#ifndef ECHOEAR_H
#define ECHOEAR_H

#include "wifi_board.h"
#include "display/display.h"
#include "backlight.h"
#include "button.h"
#include "touch_cst816s.h"
#include <esp_lcd_touch.h>
#include "charge.h"
#include "base_control.h"
#include "audio_analysis.h"
#include "touch_sensor.h"
#include "config.h"
#include <functional>

class EspS3Cat : public WifiBoard {
public:
    EspS3Cat();

    virtual AudioCodec* GetAudioCodec() override;
    virtual Display* GetDisplay() override;
    virtual Backlight* GetBacklight() override;
    esp_lcd_touch_handle_t GetTouchpad();

    virtual void SetAfeDataProcessCallback(std::function<void(const int16_t* audio_data, size_t total_bytes)> callback) override;
    virtual void SetVadStateChangeCallback(std::function<void(bool speaking)> callback) override;
    virtual void SetAudioDataProcessedCallback(std::function<void(const int16_t* audio_data, size_t bytes_per_channel, size_t channels)> callback) override;

    beat_detection_handle_t GetBeatDetectionHandle() const;
    void SetAudioAnalysisMode(AudioAnalysisMode mode);
    BaseControl* GetBaseControl()
    {
        return base_control_;
    }

    int GetDetectedPcbVersion() const
    {
        return detected_pcb_version_;
    }

    // Base UART pins must follow PCB detection (same map as config.h per version).
    // V1.0 PA uses GPIO4; using V1.2 UART RX=GPIO4 would steal the bus.
    gpio_num_t GetBaseUartTxPin() const
    {
        return detected_pcb_version_ == PCB_VERSION_V1_0 ? GPIO_NUM_6 : GPIO_NUM_5;
    }

    gpio_num_t GetBaseUartRxPin() const
    {
        return detected_pcb_version_ == PCB_VERSION_V1_0 ? GPIO_NUM_5 : GPIO_NUM_4;
    }

private:
    i2c_master_bus_handle_t i2c_bus_;
    Cst816sTouch* cst816s_touch_ = nullptr;
    Charge* charge_;
    Button boot_button_;
    Display* display_;
    PwmBacklight* backlight_;

    BaseControl* base_control_;
    AudioAnalysis* audio_analysis_;
    TouchSensor* touch_sensor_;

    // Runtime-detected audio pins (EchoEar V1.0 vs V1.2 differ).
    gpio_num_t audio_din_pin_ = GPIO_NUM_NC;
    gpio_num_t audio_pa_pin_ = GPIO_NUM_NC;
    int detected_pcb_version_ = 0;

    void InitializeI2c();
    void InitializeSpi();
    void Initializest77916Display();
    void InitializeButtons();
    void InitializeCharge();
    void InitializeCst816sTouchPad();
    void InitializeTouchSensor();
    void InitializePower();
    void DetectPcbAudioPins();
    // void create_control_ui();
};

#endif // ECHOEAR_H
