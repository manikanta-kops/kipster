<p align="center">
  <img src="docs/assets/kipster-sign.gif" alt="Kipster: Kip, a pixel chicken, acting out what a kip does while it works" width="800">
</p>

<p align="center">
  <b>Personal kips that run on your own computer.</b><br>
  They remember, plan and handle the busywork.
</p>

<p align="center">
  <a href="https://kipster.app">kipster.app</a> ·
  <a href="https://kipster.app/media/kipster-film.mp4">Watch the film (0:58)</a>
</p>

## What is Kipster

Kipster gives you a small team of AI agents called kips. Kip, your admin, is your
one point of contact: it knows what's going on and runs your other kips. Each kip
keeps its own conversations, memory and files, and all of it stays on your computer.

## How it works

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/how-it-works-dark.png">
  <img src="docs/assets/how-it-works-light.png" alt="Interfaces talk to Core, and Core talks to adapters" width="720">
</picture>

- **Interfaces** are how you talk to your kips.
- **Core** keeps everything: conversations, memory, files, work and your kips.
- **Adapters** connect Core to the AI providers that do the work.

The three parts are independent. Any interface that speaks the Kipster protocol
can talk to Core, and any provider with an adapter can do the work.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/architecture-dark.png">
  <img src="docs/assets/architecture-light.png" alt="Interfaces: macOS desktop app and web app (built), mobile app and robots or devices (planned). Core: conversations, memory, files, work and delegation, kips and organization. Adapters: AI agents Codex CLI (built), Claude Code, Pi and Muse CLI (planned); voice and memory Spokenly and Ollama (built), Wispr Flow and ElevenLabs (planned)." width="100%">
</picture>

## Status

Early development. Not yet a supported release. Setup instructions are coming soon.

## Repository

| Folder | What it holds |
| --- | --- |
| [`core/`](core) | Core, the Kipster protocol and the adapter contract |
| [`interface/`](interface) | The Kipster app for macOS and the web |
| [`adapters/`](adapters) | Provider adapters: Codex CLI, Spokenly, Ollama |
| [`docs/`](docs) | Architecture, design decisions and [releasing](docs/releasing.md) |

## License

[Apache-2.0](LICENSE)
