---
name: dynamic-workflows-dispatch
description: Decide when to use Claude Code dynamic workflows (plan + spawn hundreds of parallel subagents in one session) vs worker-agents vs a single subagent vs direct execution. Use BEFORE dispatching any multi-part task so you pick the cheapest tool that fits the scale.
when_to_use: Before any task that could fan out across many files, sources, or sites — when you are about to choose how to parallelize work and want to avoid both under-utilizing Opus 4.8 and burning tokens on trivial dispatch.
---

# Dynamic Workflows Dispatch

Opus 4.8 (2026-05-28) can run **dynamic workflows**: plan work, spawn dozens-to-hundreds of parallel subagents in one session, verify their outputs, and synthesize a result — all without leaving the session. Powerful, but Anthropic warns it uses "substantially more tokens." This skill is the decision-gate so you pick the right tool every time.

Four tools, cheapest first:

| Tool | Parallelism | Cost | Best for |
|------|-------------|------|----------|
| **Direct execution** | none | lowest | 1-3 file changes, a fix you can see end-to-end |
| **Single subagent** | 1 | low | one focused job needing isolation/fresh context |
| **Worker-agents** (`worker-agents` skill) | N headless `claude` procs | N × task | many *independent, uniform* jobs (research 10 prospects) |
| **Dynamic workflow** | dozens-hundreds, in-session | highest | *interdependent* fan-out needing plan → spawn → verify → synthesize in one loop |

## When to use a dynamic workflow

Reach for it when **3+ of these** are true:

1. **Scale**: the work naturally decomposes into 10+ parallel units (files, modules, sources, pages).
2. **Verification matters**: outputs need cross-checking/synthesis, not just collection — e.g. "fix all X, then confirm nothing else broke."
3. **Interdependence**: subtasks inform each other or a final synthesis; a flat fan-out (worker-agents) would lose the cross-talk.
4. **Wall-clock pressure**: doing it serially would take hours and the result is needed now.
5. **One-session coherence**: you want the plan, the spawning, and the verification to share context so the synthesis is consistent.

## When NOT to use one

- **Trivial / single-file**: typo, one-function fix, a config tweak. Direct execution.
- **< ~5 parallel units**: overhead and token cost exceed the benefit. Single subagent or direct.
- **Uniform independent batch with no synthesis**: use `worker-agents` — it's cheaper for flat fan-out (no in-session orchestration overhead).
- **Sequential dependency chain**: each step needs the previous result. A single agent is clearer and cheaper.
- **Exploratory / unclear scope**: scope it first (a single subagent or direct investigation), THEN decide if the fan-out is worth a workflow.

## Decision tree

```
Is the task 1-3 files / one clear fix you can see end-to-end?
  └─ YES → DIRECT EXECUTION
  └─ NO ↓
Does it need fresh/isolated context but is still ONE job?
  └─ YES → SINGLE SUBAGENT
  └─ NO ↓
Is it many INDEPENDENT, UNIFORM jobs with no cross-synthesis?
  └─ YES → WORKER-AGENTS  (see worker-agents skill)
  └─ NO ↓
Is it 10+ INTERDEPENDENT units needing plan → spawn → verify → synthesize?
  └─ YES → DYNAMIC WORKFLOW
  └─ NO  → reconsider: probably single subagent or direct
```

## How to enable

Two ways:

1. **Per-task, explicit** (preferred for our fleet): the user (or orchestrator) says *"kjør en dynamic workflow på X"* / "run a dynamic workflow on X". You then plan, spawn, verify, synthesize in-session.
2. **Standing setting**: `/ultracode` turns on dynamic-workflow-by-default for the session. Use only when a whole session is genuinely large-scale work — turn it back off after.

Default posture: do NOT auto-enable. Treat a dynamic workflow as an opt-in you propose, not a default you assume.

## Cost guardrails

Anthropic: dynamic workflows use **substantially more tokens**. Apply these every time:

- **Start scoped**: spawn against a *subset* first (e.g. 5 of 50 files), verify the pattern works, THEN scale. Don't fan out to 100 on an unproven approach.
- **Per-session confirm**: before spawning a large fan-out, state the plan + rough scale ("~40 subagents across the dashboard pages") and get a one-line go from the user/orchestrator. Big spend is an always-ask, like any production action.
- **Token-economy doctrine still applies**: structure > prose, deltas not restatements, reference not paste — inside each subagent prompt too.
- **Prefer worker-agents for flat batches**: if there's no synthesis step, worker-agents is the cheaper tool. Don't reach for a workflow just because it's the new shiny.
- **Report the spend**: when a workflow finishes, note rough scale (N subagents) so the cost is visible, not silent.

## Fleet examples

**Builder**
- "Fix all UI bugs on the dashboard" → **DYNAMIC WORKFLOW** — many interdependent files, needs verify-nothing-else-broke synthesis.
- "Fix typo in README" → **DIRECT EXECUTION**.
- "Audit + fix path-injection across all config getters" → **DYNAMIC WORKFLOW** if 10+ call-sites; **DIRECT** if it's one file (as the real PR #16 was).
- "Bump one dependency + run tests" → **DIRECT / SINGLE SUBAGENT**.

**Sales**
- "Research 50 prospects (uniform BRREG + website pull each)" → **WORKER-AGENTS** — flat, independent, no cross-synthesis; cheaper than a workflow at this scale.
- "Build a ranked ICP shortlist from 200 candidates with cross-comparison + dedup + tiering" → **DYNAMIC WORKFLOW** — the cross-comparison/synthesis is the point.
- "Draft one outreach email" → **DIRECT EXECUTION**.

**Research**
- "Deep-dive the Norwegian SaaS API ecosystem" (scope > 10 sources, needs fact-check + synthesis) → **DYNAMIC WORKFLOW** (or the `autoresearch` skill, which is a purpose-built workflow for exactly this).
- "Summarize one PDF" → **DIRECT / SINGLE SUBAGENT**.
- "Check 8 competitors' pricing pages, no synthesis, just a table" → **WORKER-AGENTS**.

**Mike (orchestrator)**
- "Audit all five agents' GOALS.md against the north star + flag drift" → **DYNAMIC WORKFLOW** — fan out per agent, synthesize a fleet-level drift report.
- "Route one deliverable to Vilhelm" → **DIRECT EXECUTION**.
- Coordinating a multi-agent push where each agent owns a track → that's **agent-to-agent dispatch**, not a workflow; use the bus.

## See also

- `worker-agents` skill — flat parallel fan-out (the cheaper sibling for uniform independent batches)
- `autoresearch` skill — a ready-made research workflow (use instead of hand-rolling one for research sweeps)
- `tasks` skill — track the work item regardless of which dispatch tool you pick
- Anthropic: Introducing Dynamic Workflows in Claude Code — https://claude.com/blog/introducing-dynamic-workflows-in-claude-code
