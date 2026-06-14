---
name: delegation-matrix
effort: low
description: "Orchestrator/agent/Codex delegation matrix. Reference this when scoping a task to determine who owns what. Codex review is the standard build policy; implementation can remain agent-owned or move to Codex by mode."
triggers: ["who owns", "delegation", "codex or agent", "should codex", "task scoping", "who does this", "delegation matrix", "codex mode"]
external_calls: []
---

# Delegation Matrix

> Reference when scoping any task. Dividing line: **execution-heavy → Codex (if configured as implementer). Judgment-heavy → Agent always.**

## Standard Build Review Policy

Codex review is the standard policy for build work before a PR is considered ready for human/merge review. The agent may still own implementation, but it should obtain and address a Codex review unless the work is a one-line/config-only change or the orchestrator explicitly marks the task as no-Codex.

Use the mode table to decide who implements. Do not use it to skip review for normal build PRs.

| Mode | Codex role | When to use |
|------|-----------|-------------|
| **Mode 1** | Standard reviewer | Agent implements; Codex reviews Agent output before PR |
| **Mode 2** | Implementer + reviewer | Codex is set up and trusted for implementation |
| **Mode 3** | Not used | Explicit no-Codex exception — Agent handles implementation and review |

---

## Ownership Matrix

| Work type | Orchestrator | Agent | Codex (Modes 1+2) |
|-----------|-------------|-------|-------------------|
| Requirement intake from user | **owns** | — | — |
| Task decomposition + dispatch | **owns** | consults | — |
| Briefings and status to user | **owns** | input | — |
| Architecture decisions | — | **owns** | — |
| Spec writing + acceptance criteria | — | **owns** | — |
| Security and domain modeling | — | **owns** | — |
| Ambiguous / judgment calls | routes | **owns** | — |
| PR decisions (file, scope, merge) | — | **owns** | — |
| First-pass implementation (clear spec) | — | **owns** (Modes 1+3) / delegates (Mode 2) | **owns** (Mode 2) |
| Mechanical refactors and migrations | — | **owns** (Modes 1+3) / delegates (Mode 2) | **owns** (Mode 2) |
| Repetitive multi-file edits | — | **owns** (Modes 1+3) / delegates (Mode 2) | **owns** (Mode 2) |
| Test drafting and fixture setup | — | **owns** (Modes 1+3) / delegates (Mode 2) | **owns** (Mode 2) |
| Code review before PR | — | **owns** only for explicit Mode 3 exception | **standard owner** (Modes 1+2) |

---

## Default Coding Workflow by Mode

### Mode 1 — Agent implements, Codex reviews

1. **Orchestrator** receives task, dispatches to Agent
2. **Agent** implements
3. **Agent** passes output to Codex for review
4. **Agent** applies Codex feedback, opens PR

### Mode 2 — Codex as implementer + reviewer

For tasks >~20 lines or touching multiple files:

1. **Orchestrator** receives task, dispatches to Agent
2. **Agent** designs the approach, writes a tight spec (what to build, file paths, expected behavior, edge cases)
3. **Agent** calls Codex with the full spec — Codex implements
4. **Agent** reviews Codex output for correctness and architectural fit
5. **Agent** opens the PR

### Mode 3 — No Codex

Use only when Codex is unavailable or the orchestrator explicitly scopes the task as no-Codex.

1. **Orchestrator** receives task, dispatches to Agent
2. **Agent** designs and implements directly
3. **Agent** opens the PR

For **one-liners and config changes**: Agent writes directly in all modes.

---

## When to Keep Implementation with Agent (Modes 1+2)

Even in Mode 2, some work stays with the Agent:
- Correct behavior is unclear and requires judgment
- Security, auth, or trust-boundary code
- Design is still open — spec isn't settled yet
- Output shown directly to users or external systems

---

*Deployment note: replace "Orchestrator" / "Agent" with your actual agent names.*
