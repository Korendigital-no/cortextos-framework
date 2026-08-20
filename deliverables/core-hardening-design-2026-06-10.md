# Core-hardening DESIGN — code-enforced approval gate (#4) + per-agent identity (#3)

**Eier:** builder2 · **Dato:** 2026-06-10 · **Status:** DESIGN-SKISSE + scaffold (IKKE merge til core — høy blast-radius, krever review + faset rollout)
**Foranledning:** WS1 security-audit funn #4 (approval-gate kun i prompt) + #3 (agent-impersonasjon, delt HMAC-nøkkel).

> Begge er multi-tenant-isolasjons-klassen managed-API løser by-construction (per-klient runtime). For SELF-hostet single-org cortextOS lukker disse to fixene «prompt-injection omgår guardrail»-klassen i kode. Ikke hast — design først, implementer bak faset rollout.

---

## #4 — Code-enforced approval gate (HIGH)

### Problemet (verifisert)
`createApproval` (src/bus/approval.ts:178) skriver en record + poster Telegram-knapper, og `needs_approval` er et task-flagg — men INGEN kode-sti blokkerer en agent fra å kjøre `cortextos bus send-telegram` / `send-message` / `git push` direkte uten en godkjent approval. Guardrailen (`approval_rules.always_ask`, types/index.ts:190) håndheves kun i agent-prompten (GUARDRAILS.md). Prompt-injection (funn #1) omgår den.

### Designet: PreToolUse-hook som enforcement-punkt
Det eneste enforcement-punktet prompt-injection IKKE kan omgå er **harness-laget** — en `PreToolUse`-hook kjører i Claude Code-runtimen, ikke i modellen. Approach:

```
Agent prøver Bash: `cortextos bus send-telegram ...`
  → PreToolUse-hook fanger kommandoen
  → classifyCommand(cmd) → ApprovalCategory | null
  → hvis kategori ∈ always_ask:
       isApprovalSatisfied(category, agent, approvals) ?
         ja  → tillat (exit 0)
         nei → BLOKKER (exit 2 + melding: «krever godkjent approval»)
```

- **Klassifisering (`classifyCommand`)**: matcher kommandoen mot kjente high-blast-radius-handlinger → `external-comms` (send-telegram/send-message til ikke-fleet), `financial`, `deployment` (git push til main / deploy-kommandoer), `data-deletion` (rm -rf / drop). Konservativ: ukjent → null (ikke blokkér alt, kun de klassifiserte always_ask-kategoriene).
- **Tilfredsstillelse (`isApprovalSatisfied`)**: en resolved approval med `status==='approved'`, samme `requesting_agent`, samme `category`, innen et ferskhets-vindu (f.eks. < 1t gammel, engangs-bruk-markering for å unngå replay av en gammel godkjenning).
- **Scaffold levert** (`src/bus/approval-gate.ts` + test) = de to rene funksjonene, ENHETSTESTET, men IKKE wiret til noen hook. Wiring (hook-registrering i templates/.claude/settings.json + en hook-entry i src/hooks) er fase 2.

### Faset rollout (kritisk — ikke big-bang på en levende flåte)
1. **Fase 0 (denne PR-en):** rene klassifiserings/sjekk-funksjoner + tester. Wiret til INGENTING. Merge-trygt isolert, men holdt for review.
2. **Fase 1 — observe-only:** hook logger «ville blokkert X» uten å blokkere (shadow-mode), i N dager → verifiser ingen false-positives mot ekte fleet-trafikk (agentene sender legitimt mye; en for-bred classifier ville frosset flåten — failure-mode B).
3. **Fase 2 — enforce:** hook blokkerer. Med en eksplisitt `CTX_APPROVAL_GATE=enforce`-bryter + en break-glass-override (operatør kan midlertidig disable hvis den feilklassifiserer i prod).

### Risiko
Hovedrisiko er **false-positive som fryser flåten** (over-restriksjon = failure-mode B fra token-economy-doktrinen). Derfor shadow-mode FØR enforce, konservativ klassifisering (ukjent→tillat), og break-glass. En for-streng gate er verre enn dagens prompt-gate fordi den stopper legitimt arbeid.

---

## #3 — Per-agent message-identitet (HIGH)

### Problemet (verifisert)
Bus-signering bruker én org-bred delt nøkkel (src/bus/message.ts:42-44), `from` settes av avsender selv → enhver agent kan sette `from` til en peer og signaturen validerer. Usignerte meldinger warn-aksepteres.

### Designet (skisse — implementasjon er fase 2, ikke i denne PR-en)
- **Per-agent nøkkelpar** (Ed25519) generert ved agent-opprettelse (`cortextos add-agent`), privat nøkkel i `state/<agent>/identity.key` (chmod 600, som bus-signing-key i dag), offentlig nøkkel publisert til et fleet-register `state/_registry/<agent>.pub`.
- **Signering**: avsender signerer `{from, to, body, ts, nonce}` med SIN private nøkkel. **Verifisering**: mottaker slår opp avsenders pubkey fra registeret og verifiserer — `from` blir kryptografisk bundet, kan ikke forfalskes uten avsenders private nøkkel.
- **Avvis usignert** når avsender har en publisert pubkey (ikke warn-aksepter).
- **Migrering**: bakoverkompatibel overgang — generer nøkler for eksisterende agenter ved neste daemon-start; aksepter både gammel HMAC og ny signatur i et overgangsvindu; flipp til signatur-only når alle agenter har nøkler. Nonce + ts → replay-beskyttelse.

### Hvorfor design-only her
Krypto-bytte + migrering på en levende multi-agent-buss er sensitivt (en feil → fleet-kommunikasjon brytes). Full design + review FØR implementasjon. Scaffold for #3 er bevisst utelatt (i motsetning til #4) fordi en halv krypto-migrering er farligere enn ingen.

---

## Leveranse-status
- **#4:** design + scaffold (`src/bus/approval-gate.ts`) + enhetstest. PR-klart, IKKE merget, IKKE wiret. Fase 1 (shadow) + fase 2 (enforce) er oppfølging.
- **#3:** design-skisse. Implementasjon er en egen, faset PR etter review.
- Begge konvergerer med managed-API-sporet: per-klient sandbox løser isolasjonen by-construction; disse fixene er for self-hostet single-org-bruk i mellomtiden.
