---
summary: "Project origin, contributors, and license."
read_when:
  - You want the project backstory or contributor credits
title: "Credits"
---

# Credits and Acknowledgments

## Origin

AllBot is an **independent project** that forked from [OpenClaw](https://github.com/openclaw/openclaw) in April 2026 and has since diverged with its own cognitive layer, architecture direction, and focus on the Chinese ecosystem (Feishu-first). The fork retains the upstream gateway architecture, plugin SDK, agent loop, and tool ecosystem as its foundation.

## Upstream acknowledgment

AllBot stands on the shoulders of **OpenClaw**, built by **Peter Steinberger** ([@steipete](https://x.com/steipete)) and the OpenClaw community. OpenClaw provided the Gateway architecture, Plugin SDK boundaries, the agent loop, multi-channel plumbing, and the full tool ecosystem — these are the foundation AllBot builds its cognitive layer on.

## AllBot

- **AllBot Contributors** ([github.com/SxLiuYu](https://github.com/SxLiuYu)) — maintainer: cognitive layer, memory rewrite, Feishu/WeChat focus, Chinese-native optimization
- **Mika** ([wangzan101/Mika](https://github.com/wangzan101/Mika)) — Android phone agent (Apache-2.0), kept in `mobile/`
- **Charlie** — voice and hardware surface, kept in `voice/`
- All AllBot-specific code (the `src/cognitive/` layer, the memory consolidation engine, the i18n locale-aware CLI) is original to this project

## License

MIT — see [LICENSE](https://github.com/SxLiuYu/allbot/blob/main/LICENSE). The upstream OpenClaw copyright notice is retained as required by the MIT license.
