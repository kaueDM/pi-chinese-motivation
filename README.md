# pi-chinese-motivation

Plays [motivational music](https://www.youtube.com/watch?v=rShjZ_op1V8) while **Chinese-origin models** (DeepSeek, MiMo, MiniMax, Kimi, Qwen, etc.) are thinking — so the longer DeepSeek takes, the more intense the soundtrack gets.

- Starts as a quiet murmur at **15% volume**
- Ramps up **+4% every 1.5 seconds** to 75%
- After **~20 seconds** of thinking: 💥 **bit-crusher distortion** kicks in
- Distortion worsens from 10-bit → 3-bit (completely blown out)

Stops instantly when the model responds. Only mpv is needed for full modulation; ffplay/vlc work as fallback players with cached audio.

## Install

```bash
# From npm (once published)
pi install npm:pi-chinese-motivation

# From git
pi install git:github.com/kaueDM/pi-chinese-motivation

# Local development
pi install ./path/to/pi-deepseek-motivation
```

## Usage

Enabled by default for Chinese-origin models. Disable with CLI flag or slash command:

```bash
pi --no-motivation-music
```

| Command | Effect |
|---------|--------|
| `/motivation-music` | Full status |
| `/motivation-music on`/`off` | Toggle |
| `/motivation-music cache` | Pre-download audio to `/tmp/pi-motivation-music/` |
| `/motivation-music url <url>` | Change the YouTube soundtrack |

## Prerequisites

- **mpv** — for YouTube streaming + real-time modulation
- **yt-dlp** — required by mpv for YouTube; also used for caching
- Optional: **ffplay** or **cvlc** — fallback players for cached files

```bash
# Ubuntu/Debian
sudo apt install mpv yt-dlp

# macOS
brew install mpv yt-dlp

# Arch
sudo pacman -S mpv yt-dlp
```

## How it works

```
agent_start fires
  ├─ mpv starts via IPC socket (--input-ipc-server)
  ├─ Volume ramp: 15% → 75% over ~22s
  ├─ After 20s: lavfi-acrusher activates
  └─ agent_end → killed instantly
```

The extension hooks into pi's `agent_start`/`agent_end` events and only triggers when the active model matches known Chinese AI providers (DeepSeek, Moonshot/Kimi, Alibaba/Qwen, ByteDance/Doubao, Zhipu/GLM, Baidu/ERNIE, Tencent/Hunyuan, Xiaomi/MiMo, MiniMax, StepFun, 01.AI/Yi, Baichuan, SenseTime).

## License

MIT
