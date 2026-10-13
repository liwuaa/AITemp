#ifndef MUSIC_PLAYER_H
#define MUSIC_PLAYER_H

#include <atomic>
#include <condition_variable>
#include <mutex>
#include <string>
#include <vector>
#include <memory>

#include <freertos/FreeRTOS.h>
#include <freertos/task.h>

#include "device_state.h"
#include "http.h"

enum class MusicPlayState {
    kIdle,
    kPlaying,
    kPausedUser,
    kPausedAi,
};

/** Streams 16 kHz mono s16le PCM from PC /proxy/pcm (MP3 decoded on PC). */
class MusicPlayer {
public:
    static MusicPlayer& GetInstance();

    MusicPlayer(const MusicPlayer&) = delete;
    MusicPlayer& operator=(const MusicPlayer&) = delete;

    bool Play(const std::string& url, const std::string& title = "");
    void Pause();
    void Resume();
    void Stop();

    MusicPlayState GetState() const { return state_.load(); }
    std::string GetStatusJson() const;

    void OnDeviceStateChanged(DeviceState previous, DeviceState current);

private:
    MusicPlayer();
    ~MusicPlayer();

    void EnsureWorker();
    void RequestStopWorker();
    static void WorkerEntry(void* arg);
    void WorkerLoop();

    bool OpenHttp();
    void CloseHttp();
    bool ShouldHoldForAi(DeviceState state) const;

    mutable std::mutex mutex_;
    std::condition_variable cv_;
    std::atomic<MusicPlayState> state_{MusicPlayState::kIdle};
    std::atomic<bool> stop_worker_{false};
    std::atomic<bool> worker_running_{false};
    TaskHandle_t worker_task_ = nullptr;

    std::string url_;
    std::string title_;
    bool resume_after_ai_ = false;
    uint32_t stream_generation_ = 0;

    std::unique_ptr<Http> http_;
    std::vector<uint8_t> read_buf_;
};

#endif
