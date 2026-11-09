# E88 Agent choice, tag channels and the prompt library on the phone

Milestone: standalone (Mobile). Depends on: E86, E87.

## Goal

Pick the CLI, model and effort for an agent from the phone, delete tags and tag pre-releases, and
use Prompt Builder templates, history and scheduling.

## Design

- Model and effort come from the desktop's launch picker. The bridge only accepts a model the CLI
  offers, so nothing else can end up on its command line.
- Fix with AI and auto-fix ask in a sheet that says what will happen and takes the agent choice.
- `apps/desktop/src/main/agents/promptLaunch.ts` starts an agent from main, for the phone and for the
  scheduler. With no window open a due task now starts from main instead of being missed.
- Prompts generated on the phone are recorded in the same history as the desktop's.

## Acceptance

- [x] AC1 Agents take a CLI, model and effort, and an unknown model is refused
- [x] AC2 Tags offer stable, beta and preview, and a recent tag can be deleted here and on the remote
- [x] AC3 Templates can be listed, used, saved and deleted
- [x] AC4 History can be searched and brought back
- [x] AC5 A prompt can be scheduled, listed and cancelled
- [ ] AC6 Tried end to end against a real computer

## State

The bridge, core and Android screens are tested. `promptLaunch.ts` and tag deletion against real git
have only been type-checked. A task can't start while Runova itself is closed. The iOS screens are
written to match but have never been compiled.
