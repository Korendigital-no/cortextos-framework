'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { IconSparkles, IconCircleCheck, IconLoader2, IconChevronRight } from '@tabler/icons-react';
import { NICHE_PRESETS, getPreset, DEFAULT_PRESET_ID } from '@/lib/demo/niches';
import { STAGE_ORDER, type StageKey } from '@/lib/demo/pipeline';
import type { Teardown, Concepts, Scripts, UgcResult } from '@/lib/demo/prompts';

const STAGE_LABELS: Record<StageKey, string> = {
  teardown: 'River ned vinner-mønstre',
  concepts: 'Genererer konsepter',
  scripts: 'Skriver manus',
  ugc: 'Definerer creator-persona',
};

const PLATFORMS = ['TikTok', 'Meta', 'Snapchat'];

interface Brief {
  produkt: string; maalgruppe: string; tilbud: string; plattform: string; husstil_eksempler: string;
}

function briefFromPreset(id: string): Brief {
  const p = getPreset(id) ?? NICHE_PRESETS[0];
  return { produkt: p.produkt, maalgruppe: p.maalgruppe, tilbud: p.tilbud, plattform: p.plattform, husstil_eksempler: p.husstil_eksempler };
}

export default function FulcioDemoPage() {
  const [presetId, setPresetId] = useState(DEFAULT_PRESET_ID);
  const [brief, setBrief] = useState<Brief>(briefFromPreset(DEFAULT_PRESET_ID));
  const [running, setRunning] = useState(false);
  const [currentStage, setCurrentStage] = useState<StageKey | null>(null);
  const [done, setDone] = useState<Set<StageKey>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [meta, setMeta] = useState<{ provider: string; model: string; seconds: number } | null>(null);

  const [teardown, setTeardown] = useState<Teardown | null>(null);
  const [concepts, setConcepts] = useState<Concepts | null>(null);
  const [scripts, setScripts] = useState<Scripts | null>(null);
  const [ugc, setUgc] = useState<UgcResult | null>(null);

  const preset = getPreset(presetId);

  function applyPreset(id: string) {
    setPresetId(id);
    setBrief(briefFromPreset(id));
  }

  function setField(k: keyof Brief, v: string) {
    setBrief(b => ({ ...b, [k]: v }));
  }

  async function runStage(stage: StageKey, context: Record<string, unknown>) {
    const res = await fetch('/api/demo/generate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stage, brief, context }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || `Stage ${stage} failed`);
    return json as { data: unknown; provider: string; model: string };
  }

  async function generate() {
    setRunning(true); setError(null); setDone(new Set()); setMeta(null);
    setTeardown(null); setConcepts(null); setScripts(null); setUgc(null);
    const t0 = Date.now();
    const ctx: Record<string, unknown> = {};
    let provider = '', model = '';
    try {
      for (const stage of STAGE_ORDER) {
        setCurrentStage(stage);
        const { data, provider: p, model: m } = await runStage(stage, ctx);
        provider = p; model = m;
        ctx[stage] = data;
        if (stage === 'teardown') setTeardown(data as Teardown);
        if (stage === 'concepts') setConcepts(data as Concepts);
        if (stage === 'scripts') setScripts(data as Scripts);
        if (stage === 'ugc') setUgc(data as UgcResult);
        setDone(d => new Set(d).add(stage));
      }
      setMeta({ provider, model, seconds: (Date.now() - t0) / 1000 });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false); setCurrentStage(null);
    }
  }

  const hasResults = teardown || concepts || scripts || ugc;

  return (
    <div className="space-y-6 max-w-5xl">
      <div>
        <div className="flex items-center gap-2">
          <IconSparkles className="size-6 text-primary" />
          <h1 className="text-2xl font-semibold">Kampanje-motor</h1>
          <Badge variant="secondary">demo</Badge>
        </div>
        <p className="text-sm text-muted-foreground mt-1">
          Én brief + vinner-annonser fra nisjen → hele kampanje-råmaterialet på under et minutt, i husstilens stemme.
        </p>
      </div>

      {/* Input */}
      <div className="rounded-xl border bg-card p-5 space-y-4">
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-sm">
            <span className="text-muted-foreground">Nisje</span>
            <select value={presetId} onChange={e => applyPreset(e.target.value)} disabled={running}
              className="mt-1 block rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring">
              {NICHE_PRESETS.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
            </select>
          </label>
          <label className="text-sm">
            <span className="text-muted-foreground">Plattform</span>
            <select value={brief.plattform} onChange={e => setField('plattform', e.target.value)} disabled={running}
              className="mt-1 block rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring">
              {PLATFORMS.map(p => <option key={p} value={p}>{p}</option>)}
            </select>
          </label>
        </div>

        {preset && (
          <p className="text-xs text-muted-foreground border-l-2 border-amber-400/50 pl-2">
            {preset.provenance === 'real-verified' ? 'Ekte Fulcio-kunde. ' : 'Illustrativt eksempel. '}{preset.provenanceNote}
          </p>
        )}

        <div className="grid gap-3">
          <Field label="Produkt / kunde" value={brief.produkt} onChange={v => setField('produkt', v)} disabled={running} />
          <Field label="Målgruppe" value={brief.maalgruppe} onChange={v => setField('maalgruppe', v)} disabled={running} />
          <Field label="Tilbud / vinkel" value={brief.tilbud} onChange={v => setField('tilbud', v)} disabled={running} />
          <label className="text-sm">
            <span className="text-muted-foreground">Husstil-eksempler (vinner-annonser fra nisjen)</span>
            <textarea value={brief.husstil_eksempler} onChange={e => setField('husstil_eksempler', e.target.value)} disabled={running}
              className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-ring min-h-[140px]" />
          </label>
        </div>

        <div className="flex items-center gap-3">
          <Button onClick={generate} disabled={running}>
            {running ? <IconLoader2 className="size-4 mr-1 animate-spin" /> : <IconSparkles className="size-4 mr-1" />}
            {running ? 'Genererer…' : 'Generer kampanje-råmateriale'}
          </Button>
          {meta && <span className="text-xs text-muted-foreground">Generert live på {meta.seconds.toFixed(0)}s · {meta.model}</span>}
        </div>
      </div>

      {/* Progress */}
      {running && (
        <div className="rounded-xl border bg-card p-5">
          <div className="space-y-2">
            {STAGE_ORDER.map(stage => (
              <div key={stage} className="flex items-center gap-2 text-sm">
                {done.has(stage) ? <IconCircleCheck className="size-4 text-emerald-500" />
                  : currentStage === stage ? <IconLoader2 className="size-4 text-primary animate-spin" />
                  : <span className="size-4 rounded-full border border-muted-foreground/30 inline-block" />}
                <span className={done.has(stage) ? 'text-foreground' : currentStage === stage ? 'text-foreground' : 'text-muted-foreground'}>
                  {STAGE_LABELS[stage]}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {error && (
        <div className="rounded-xl border border-red-300 bg-red-50 dark:bg-red-950/20 p-4 text-sm text-red-700 dark:text-red-400">
          Noe gikk galt: {error}
        </div>
      )}

      {/* Results */}
      {hasResults && (
        <div className="space-y-4">
          {teardown && (
            <Card title="Ad-teardown" subtitle="Vinner-mønstrene trukket ut av nisjens annonser">
              <div className="grid sm:grid-cols-2 gap-4">
                <TList title="Hook-mønstre" items={teardown.hook_patterns} />
                <TList title="Gjentakende vinkler" items={teardown.recurring_angles} />
                <TList title="Hvorfor det funker" items={teardown.why_it_works} />
                <TList title="Husstil-kjennetegn" items={teardown.house_voice_traits} />
              </div>
            </Card>
          )}

          {concepts && (
            <Card title="Konsepter" subtitle={`${concepts.concepts.length} distinkte vinkler`}>
              <div className="grid sm:grid-cols-2 gap-3">
                {concepts.concepts.map((c, i) => (
                  <div key={i} className="rounded-lg border bg-background p-3 space-y-1">
                    <p className="font-medium text-sm">{c.title}</p>
                    <p className="text-xs text-muted-foreground">{c.angle}</p>
                    <p className="text-sm mt-1"><span className="text-muted-foreground">Hook:</span> {c.hook}</p>
                    <p className="text-xs text-muted-foreground italic">{c.why_it_lands}</p>
                  </div>
                ))}
              </div>
            </Card>
          )}

          {scripts && (
            <Card title="Ferdige manus" subtitle="Innspillingsklare, i husstilens stemme">
              <div className="space-y-3">
                {scripts.scripts.map((s, i) => (
                  <div key={i} className="rounded-lg border bg-background p-3 space-y-1.5">
                    <div className="flex items-center gap-2">
                      <p className="font-medium text-sm">{s.concept_title}</p>
                      <Badge variant="secondary" className="text-xs">{s.platform}</Badge>
                    </div>
                    <p className="text-sm"><span className="text-muted-foreground">Hook:</span> {s.hook}</p>
                    <p className="text-sm"><span className="text-muted-foreground">Body:</span> {s.body}</p>
                    <p className="text-sm"><span className="text-muted-foreground">CTA:</span> {s.cta}</p>
                  </div>
                ))}
              </div>
            </Card>
          )}

          {ugc && (
            <Card title="UGC-manus + creator-persona" subtitle="Manus å fremføre + hvem som bør fremføre det">
              <div className="grid sm:grid-cols-2 gap-4">
                <div className="rounded-lg border bg-background p-3 space-y-1.5">
                  <p className="font-medium text-sm">UGC-manus</p>
                  <p className="text-sm"><span className="text-muted-foreground">Hook:</span> {ugc.ugc_script.hook}</p>
                  <ul className="text-sm list-disc pl-4 text-foreground/90">
                    {ugc.ugc_script.talking_points.map((t, i) => <li key={i}>{t}</li>)}
                  </ul>
                  <p className="text-sm"><span className="text-muted-foreground">CTA:</span> {ugc.ugc_script.cta}</p>
                  <p className="text-xs text-muted-foreground italic">{ugc.ugc_script.tone_note}</p>
                </div>
                <div className="rounded-lg border bg-background p-3 space-y-1">
                  <p className="font-medium text-sm">Creator-persona</p>
                  <p className="text-sm">{ugc.creator_persona.archetype} · {ugc.creator_persona.age_range}</p>
                  <p className="text-sm text-muted-foreground">{ugc.creator_persona.style}</p>
                  <p className="text-xs text-muted-foreground italic mt-1">{ugc.creator_persona.why_this_creator}</p>
                </div>
              </div>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}

function Field({ label, value, onChange, disabled }: { label: string; value: string; onChange: (v: string) => void; disabled?: boolean }) {
  return (
    <label className="text-sm">
      <span className="text-muted-foreground">{label}</span>
      <input type="text" value={value} onChange={e => onChange(e.target.value)} disabled={disabled}
        className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring" />
    </label>
  );
}

function Card({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border bg-card p-5">
      <div className="flex items-center gap-2 mb-3">
        <IconChevronRight className="size-4 text-primary" />
        <h2 className="text-lg font-medium">{title}</h2>
        {subtitle && <span className="text-xs text-muted-foreground">· {subtitle}</span>}
      </div>
      {children}
    </div>
  );
}

function TList({ title, items }: { title: string; items: string[] }) {
  return (
    <div>
      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1">{title}</p>
      <ul className="text-sm space-y-1 list-disc pl-4 text-foreground/90">
        {items.map((it, i) => <li key={i}>{it}</li>)}
      </ul>
    </div>
  );
}
