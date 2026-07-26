#include "music_player.h"

#include "application.h"
#include "board.h"
#include "device_state_event.h"

#include <esp_log.h>
#include <esp_timer.h>
#include <cstring>
#include <algorithm>

#define TAG "MusicPlayer"

namespace {
constexpr int kSampleRate = 16000;
constexpr int kFrameSamples = 960;  // 60ms
constexpr size_t kFrameBytes = kFrameSamples * sizeof(int16_t);
constexpr size_t kReadChunk = 4 * 1024;
constexpr UBaseType_t kWorkerPriority = 2;
constexpr uint32_t kWorkerStack = 8 * 1024;
}  // namespace

MusicPlayer& MusicPlayer::GetInstance() {
    static MusicPlayer instance;
    return instance;
}

MusicPlayer::MusicPlayer() {
    read_buf_.resize(kReadChunk);
    DeviceStateEventManager::GetInstance().RegisterStateChangeCallback(
        [this](DeviceState previous, DeviceState current) {
            OnDeviceStateChanged(previous, current);
        });
}

MusicPlayer::~MusicPlayer() {
    Stop();
    RequestStopWorker();
}

bool MusicPlayer::ShouldHoldForAi(DeviceState state) const {
    return state == kDeviceStateSpeaking ||
           state == kDeviceStateListening ||
           state == kDeviceStateConnecting;
}

void MusicPlayer::OnDeviceStateChanged(DeviceState /*previous*/, DeviceState current) {
    if (ShouldHoldForAi(current)) {
        std::lock_guard<std::mutex> lock(mutex_);
        if (state_ == MusicPlayState::kPlaying) {
            state_ = MusicPlayState::kPausedAi;
            resume_after_ai_ = true;
            ESP_LOGI(TAG, "Yield to AI, music paused");
            cv_.notify_all();
        }
        return;
    }
    if (current == kDeviceStateIdle) {
        std::lock_guard<std::mutex> lock(mutex_);
        if (state_ == MusicPlayState::kPausedAi && resume_after_ai_ && !url_.empty()) {
            state_ = MusicPlayState::kPlaying;
            ESP_LOGI(TAG, "AI idle, resume music: %s", title_.c_str());
            cv_.notify_all();
        }
    }
}

bool MusicPlayer::Play(const std::string& url, const std::string& title) {
    if (url.empty()) {
        return false;
    }
    if (url.rfind("https://", 0) == 0) {
        ESP_LOGE(TAG, "HTTPS/CDN not supported. Use http://PC_IP:3210/proxy/pcm?songmid=...");
        return false;
    }

    std::string play_url = url;
    auto pos = play_url.find("/proxy/play");
    if (pos != std::string::npos) {
        play_url.replace(pos, 11, "/proxy/pcm");
    }
    if (play_url.find("/proxy/pcm") == std::string::npos) {
        ESP_LOGE(TAG, "Need PCM proxy URL (/proxy/pcm), got: %s", url.c_str());
        return false;
    }

    {
        std::lock_guard<std::mutex> lock(mutex_);
        url_ = play_url;
        title_ = title;
        ++stream_generation_;

        auto device_state = Application::GetInstance().GetDeviceState();
        if (ShouldHoldForAi(device_state)) {
            state_ = MusicPlayState::kPausedAi;
            resume_after_ai_ = true;
            ESP_LOGI(TAG, "Play queued until AI finishes: %s", title_.c_str());
        } else {
            state_ = MusicPlayState::kPlaying;
            resume_after_ai_ = true;
            ESP_LOGI(TAG, "Play start: %s", title_.empty() ? url_.c_str() : title_.c_str());
        }
    }
    EnsureWorker();
    cv_.notify_all();
    return true;
}

void MusicPlayer::Pause() {
    std::lock_guard<std::mutex> lock(mutex_);
    if (state_ == MusicPlayState::kPlaying || state_ == MusicPlayState::kPausedAi) {
        state_ = MusicPlayState::kPausedUser;
        resume_after_ai_ = false;
        ESP_LOGI(TAG, "Music paused by user");
        cv_.notify_all();
    }
}

void MusicPlayer::Resume() {
    std::lock_guard<std::mutex> lock(mutex_);
    if (url_.empty()) {
        return;
    }
    auto device_state = Application::GetInstance().GetDeviceState();
    if (ShouldHoldForAi(device_state)) {
        state_ = MusicPlayState::kPausedAi;
        resume_after_ai_ = true;
    } else if (state_ == MusicPlayState::kPausedUser || state_ == MusicPlayState::kPausedAi ||
               state_ == MusicPlayState::kIdle) {
        state_ = MusicPlayState::kPlaying;
        resume_after_ai_ = true;
        ESP_LOGI(TAG, "Music resumed");
    }
    cv_.notify_all();
}

void MusicPlayer::Stop() {
    {
        std::lock_guard<std::mutex> lock(mutex_);
        state_ = MusicPlayState::kIdle;
        resume_after_ai_ = false;
        url_.clear();
        title_.clear();
        ++stream_generation_;
        ESP_LOGI(TAG, "Music stopped");
    }
    cv_.notify_all();
    Application::GetInstance().GetAudioService().ResetDecoder();
}

std::string MusicPlayer::GetStatusJson() const {
    std::lock_guard<std::mutex> lock(mutex_);
    const char* state = "idle";
    switch (state_.load()) {
        case MusicPlayState::kPlaying: state = "playing"; break;
        case MusicPlayState::kPausedUser: state = "paused"; break;
        case MusicPlayState::kPausedAi: state = "paused_for_ai"; break;
        default: break;
    }
    std::string safe_title;
    for (char c : title_) {
        if (c == '"' || c == '\\') {
            safe_title.push_back(' ');
        } else if (static_cast<unsigned char>(c) >= 0x20) {
            safe_title.push_back(c);
        }
    }
    char buf[512];
    snprintf(buf, sizeof(buf),
             "{\"state\":\"%s\",\"title\":\"%s\",\"resume_after_ai\":%s,\"format\":\"pcm_s16le_16k\"}",
             state, safe_title.c_str(), resume_after_ai_ ? "true" : "false");
    return std::string(buf);
}

void MusicPlayer::EnsureWorker() {
    if (worker_running_) {
        return;
    }
    stop_worker_ = false;
    worker_running_ = true;
    BaseType_t ok = xTaskCreate(WorkerEntry, "music_pcm", kWorkerStack, this,
                                kWorkerPriority, &worker_task_);
    if (ok != pdPASS) {
        worker_running_ = false;
        worker_task_ = nullptr;
        ESP_LOGE(TAG, "Failed to create music worker");
    }
}

void MusicPlayer::RequestStopWorker() {
    stop_worker_ = true;
    cv_.notify_all();
    vTaskDelay(pdMS_TO_TICKS(50));
}

void MusicPlayer::WorkerEntry(void* arg) {
    reinterpret_cast<MusicPlayer*>(arg)->WorkerLoop();
    reinterpret_cast<MusicPlayer*>(arg)->worker_running_ = false;
    reinterpret_cast<MusicPlayer*>(arg)->worker_task_ = nullptr;
    vTaskDelete(nullptr);
}

void MusicPlayer::CloseHttp() {
    if (http_) {
        http_->Close();
        http_.reset();
    }
}

bool MusicPlayer::OpenHttp() {
    CloseHttp();
    std::string url;
    {
        std::lock_guard<std::mutex> lock(mutex_);
        url = url_;
    }
    if (url.empty()) {
        return false;
    }
    auto network = Board::GetInstance().GetNetwork();
    if (!network) {
        ESP_LOGE(TAG, "No network");
        return false;
    }
    http_ = network->CreateHttp(1);
    if (!http_) {
        return false;
    }
    http_->SetTimeout(15000);
    http_->SetHeader("User-Agent", "XiaozhiMusicPlayerPCM/2.0");
    http_->SetHeader("Accept", "application/octet-stream,*/*");
    ESP_LOGI(TAG, "HTTP GET %s", url.c_str());
    if (!http_->Open("GET", url)) {
        ESP_LOGE(TAG, "HTTP open failed — set MUSIC_PROXY_HOST to PC WiFi IP (same LAN as device)");
        CloseHttp();
        return false;
    }
    int code = http_->GetStatusCode();
    if (code != 200) {
        ESP_LOGE(TAG, "HTTP status %d", code);
        CloseHttp();
        return false;
    }
    ESP_LOGI(TAG, "PCM stream opened");
    return true;
}

void MusicPlayer::WorkerLoop() {
    ESP_LOGI(TAG, "PCM music worker started");
    uint32_t active_generation = 0;

    while (!stop_worker_) {
        {
            std::unique_lock<std::mutex> lock(mutex_);
            cv_.wait(lock, [this]() {
                return stop_worker_ || state_ == MusicPlayState::kPlaying;
            });
            if (stop_worker_) {
                break;
            }
            if (url_.empty()) {
                state_ = MusicPlayState::kIdle;
                continue;
            }
            active_generation = stream_generation_;
        }

        if (!OpenHttp()) {
            std::lock_guard<std::mutex> lock(mutex_);
            if (stream_generation_ == active_generation) {
                state_ = MusicPlayState::kIdle;
            }
            vTaskDelay(pdMS_TO_TICKS(200));
            continue;
        }

        std::vector<uint8_t> pending;
        pending.reserve(kFrameBytes * 2);
        int64_t played_samples = 0;
        int64_t stream_start_us = esp_timer_get_time();
        bool stream_done = false;
        int frames = 0;
        bool abort_stream = false;

        while (!stop_worker_ && !stream_done && !abort_stream) {
            {
                std::unique_lock<std::mutex> lock(mutex_);
                if (stream_generation_ != active_generation) {
                    break;
                }
                if (state_ == MusicPlayState::kPausedUser || state_ == MusicPlayState::kPausedAi) {
                    lock.unlock();
                    CloseHttp();
                    lock.lock();
                    cv_.wait(lock, [this, active_generation]() {
                        return stop_worker_ || state_ == MusicPlayState::kPlaying ||
                               state_ == MusicPlayState::kIdle ||
                               stream_generation_ != active_generation;
                    });
                    if (stop_worker_ || state_ == MusicPlayState::kIdle ||
                        stream_generation_ != active_generation) {
                        break;
                    }
                    pending.clear();
                    played_samples = 0;
                    stream_start_us = esp_timer_get_time();
                    lock.unlock();
                    if (!OpenHttp()) {
                        std::lock_guard<std::mutex> lock2(mutex_);
                        if (stream_generation_ == active_generation) {
                            state_ = MusicPlayState::kIdle;
                        }
                        break;
                    }
                    continue;
                }
                if (state_ != MusicPlayState::kPlaying) {
                    if (state_ == MusicPlayState::kIdle) {
                        break;
                    }
                    continue;
                }
            }

            if (!http_) {
                break;
            }

            int n = http_->Read(reinterpret_cast<char*>(read_buf_.data()),
                                static_cast<int>(read_buf_.size()));
            if (n > 0) {
                pending.insert(pending.end(), read_buf_.begin(), read_buf_.begin() + n);
            } else if (n == 0) {
                stream_done = true;
            } else {
                ESP_LOGW(TAG, "HTTP read error");
                break;
            }

            while (pending.size() >= kFrameBytes) {
                std::vector<int16_t> frame(kFrameSamples);
                std::memcpy(frame.data(), pending.data(), kFrameBytes);
                pending.erase(pending.begin(),
                              pending.begin() + static_cast<std::ptrdiff_t>(kFrameBytes));

                {
                    std::unique_lock<std::mutex> lock(mutex_);
                    auto device_state = Application::GetInstance().GetDeviceState();
                    if (ShouldHoldForAi(device_state) && state_ == MusicPlayState::kPlaying) {
                        state_ = MusicPlayState::kPausedAi;
                        resume_after_ai_ = true;
                        abort_stream = true;
                        break;
                    }
                    cv_.wait(lock, [this]() {
                        return stop_worker_ || state_ != MusicPlayState::kPausedAi;
                    });
                    if (stop_worker_ || state_ != MusicPlayState::kPlaying) {
                        abort_stream = true;
                        break;
                    }
                }

                auto& audio = Application::GetInstance().GetAudioService();
                std::vector<int16_t> to_push = frame;
                while (!audio.PushPcmForPlayback(std::move(to_push), false)) {
                    if (stop_worker_ || state_ != MusicPlayState::kPlaying) {
                        abort_stream = true;
                        break;
                    }
                    vTaskDelay(pdMS_TO_TICKS(20));
                    to_push = frame;
                }
                if (abort_stream) {
                    break;
                }

                played_samples += kFrameSamples;
                ++frames;
                if (frames == 1) {
                    ESP_LOGI(TAG, "First PCM frame pushed");
                }

                int64_t due = stream_start_us + (played_samples * 1000000LL) / kSampleRate;
                int64_t now = esp_timer_get_time();
                if (due > now + 8000) {
                    vTaskDelay(pdMS_TO_TICKS(static_cast<uint32_t>((due - now) / 1000)));
                } else {
                    taskYIELD();
                }
            }
        }

        CloseHttp();
        {
            std::lock_guard<std::mutex> lock(mutex_);
            if (stream_generation_ != active_generation) {
                continue;
            }
            if (state_ == MusicPlayState::kPlaying && stream_done) {
                ESP_LOGI(TAG, "Music finished: %s (%d frames)", title_.c_str(), frames);
                state_ = MusicPlayState::kIdle;
                resume_after_ai_ = false;
                url_.clear();
            }
        }
    }

    CloseHttp();
    ESP_LOGI(TAG, "PCM music worker exit");
}
