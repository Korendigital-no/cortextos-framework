// Fulcio demo — niche presets (REAL niche-winners).
//
// Spec v2's core idea: ONE generic engine, niche-tailored OUTPUT, because the
// INPUT is real niche-specific winning ads (not a template). These three presets
// are MAX-CONTRASTING real verticals with VERBATIM active Meta ads (Library-ID +
// days-active as the winner signal), staged by research from the Meta Ad Library
// (NO, 2026-06-03). They share almost no traits — that's the demo's punchline:
// a generic template cannot win in all three, so the agent must build from THAT
// niche's actual winners.
//
// Money-shot: run two niches live (e.g. helse vs eiendom) and show the output
// STYLE diverges because the input winners diverge.
//
// `husstil_eksempler` = real verified winners (provenance real-verified). The
// campaign `produkt`/`maalgruppe`/`tilbud` is the hypothetical new client we
// generate a campaign for, grounded in that niche's winning patterns.

export type Provenance = 'illustrative' | 'real-verified';

export interface NichePreset {
  id: string;
  label: string;
  provenance: Provenance;
  provenanceNote: string;
  produkt: string;
  maalgruppe: string;
  tilbud: string;
  plattform: string;
  husstil_eksempler: string;
}

// NICHE 1 — Health / supplements (DTC). Winner pattern: emotional problem-
// agitation, social proof in numbers, free trial / aggressive discount, expert
// endorsement, long emotional copy, hard-sell CTA.
const HELSE: NichePreset = {
  id: 'helse-kosttilskudd',
  label: 'Helse / kosttilskudd (DTC)',
  provenance: 'real-verified',
  provenanceNote: 'Ekte aktive Meta-annonser (Norge, hentet 2026-06-03). Vinner-signal = lengst-kjørende aktiv annonse. Bibliotek-IDer verifiserbare i Meta Ad Library. Kampanje-briefen under er en hypotetisk ny kunde i nisjen.',
  produkt: 'NordVital Daglig (kosttilskudd for energi og restitusjon)',
  maalgruppe: 'Helse-bevisste voksne 25-45 som sliter med energi og restitusjon',
  tilbud: 'Gratis prøvepakke, social proof med ekte brukerresultater',
  plattform: 'Meta',
  husstil_eksempler: `[ISBLÅ — 654 dager aktiv, Bibliotek-ID 1869065110282895]
Hook: En hårmineralanalyse kan hjelpe deg med å tilpasse ditt personlige behov for kosttilskudd som vitaminer og mineraler, slik at det passer for deg og din kropp.
Body: Rapporten avslører om du har tungmetallbelastninger. I tillegg får du vite hva slags kosthold som er optimalt for deg.
Overskrift: Hårmineralanalyse med utførlig rapport
CTA: Order Now

[BROTH COMPANY — 162 dager, Bibliotek-ID 1189680246602175]
Hook: Naturlig restitusjon for atleter.
Body: Bone Broth Recovery hjelper deg å yte mer og hente deg inn raskere, 100 % naturlig, rik på protein, kollagen og aminosyrer. Et smartere valg enn ultraprosesserte kosttilskudd.
Bevis: 15000+ kunder
CTA: Kjøp nå

[HELSEBLOGG — 118 dager, Bibliotek-ID 1588489315608925] (DR-VSL)
Hook: Visste du at den oppblåste magen, det endeløse presset på toalettet og følelsen av at noe sitter fast ikke er et normalt tegn på aldring?
Body: Likevel får millioner høre dette hver dag. "Drikk mer vann." "Spis mer fiber." Men hva om tarmene dine ikke er late, men bokstavelig talt bremset? Du våkner med en full, stram mage. Presset. Skammen. Du avlyser avtaler.

[SUNNERE MEG — 65 dager, Bibliotek-ID 4090831027727780]
Hook: Når hals og bryst føles mer tungt enn før, og kroppen kjennes tyngre, er det lett å bare holde ut, men du kan faktisk bli kvitt plagene igjen.
Tilbud: Nå deler vi ut hele 10 000 gratis prøvepakker av Kjerringrokk Pluss.
Autoritet: Helseekspert Hogne Vik.
CTA: Mer informasjon

[ZOOCA — 75 dager, Bibliotek-ID 968775102153658]
Hook: Få bedre restitusjon med kosttilskuddet Zooca SPORT.
Body: Over 40 fettsyrer og næringsstoffer (astaxanthin, vitamin D, sink, selen, magnesium) som støtter energiomsetning, muskelfunksjon og beskyttelse mot oksidativt stress.
Tilbud: 70% rabatt på første pakke. Prøv 30 dager, kun 79,-
CTA: Bestill nå`,
};

// NICHE 2 — Real estate (local service). Winner pattern: trust & gratitude,
// local authority, dignity/stewardship not selling, short copy, soft consultative
// CTA, NO discount/urgency/number-proof.
const EIENDOM: NichePreset = {
  id: 'eiendom',
  label: 'Eiendom / eiendomsmegler (lokal tjeneste)',
  provenance: 'real-verified',
  provenanceNote: 'Ekte aktive Meta-annonser (Norge, hentet 2026-06-03). Vinner-signal = lengst-kjørende aktiv annonse. Bibliotek-IDer verifiserbare i Meta Ad Library. Kampanje-briefen under er en hypotetisk ny kunde i nisjen.',
  produkt: 'Lokalmegleren AS (eiendomsmegler, bydels-spesialist)',
  maalgruppe: 'Boligselgere som vil ha trygg, lokalkjent forvaltning av boligsalget',
  tilbud: 'Gratis verdivurdering, skreddersydd lokal meglertjeneste',
  plattform: 'Meta',
  husstil_eksempler: `[PRIVATMEGLEREN — 177 dager aktiv, Bibliotek-ID 1054279630135240]
Hook: Vi er utrolig takknemlige for at så mange boligselgere har valgt oss til å forvalte det mest verdifulle de eier. Tusen takk for tilliten.
Overskrift: PrivatMegleren Première, Eiendomsmegler Oppsal
Body: Vi tilbyr skreddersydde meglertjenester med fokus på kvalitet, trygghet og lokal kunnskap om Oppsal.
CTA: Finn ut mer

[EIENDOMSMEGLER NORGE — 39 dager, Bibliotek-ID 1281770723468846]
Hook: Det viktigste stedet i Norge er der du bor. Sørg for at du får det du fortjener når du selger det.
CTA: Bestill verdivurdering her

[EIENDOMSMEGLER NORGE (skjærgård), Bibliotek-ID 1657640002245618]
Hook: Selg fritidsboligen med lokale eksperter. Våre skjærgårdsmeglere hjelper deg hele veien.
CTA: Kontakt våre skjærgårdsmeglere

[EIENDOMSMEGLER 1 MIDT-NORGE — 19 dager, Bibliotek-ID 968371692638658]
Hook: Velg en områdespesialist, vår erfaring og vårt nettverk er din fordel når du skal selge bolig.
Body: Områdespesialistene som kjenner Trondheim. Vi har verdifull lokalkunnskap når du skal selge bolig.
CTA: Start boligsalget`,
};

// NICHE 3 — B2B SaaS / accounting (rational purchase). Winner pattern: rational
// ROI/cost value-prop, simplicity/low-friction, educational/advisory content,
// free trial/registration, functional CTA, sober tone, no emotion.
const REGNSKAP: NichePreset = {
  id: 'b2b-regnskap',
  label: 'B2B regnskapsprogram (SaaS)',
  provenance: 'real-verified',
  provenanceNote: 'Ekte aktive Meta-annonser (Norge, hentet 2026-06-03). Vinner-signal = lengst-kjørende aktiv annonse. Bibliotek-IDer verifiserbare i Meta Ad Library. Kampanje-briefen under er en hypotetisk ny kunde i nisjen.',
  produkt: 'BokførPro (AI-basert regnskapsprogram for små bedrifter)',
  maalgruppe: 'Daglige ledere i små og mellomstore norske bedrifter',
  tilbud: 'Gratis prøve i 30 dager, spar tid og kostnad på regnskap',
  plattform: 'Meta',
  husstil_eksempler: `[SNØHETTA REGNSKAP — 182 dager aktiv, Bibliotek-ID 1906364304098448]
Hook: PowerOffice Go og Tripletex er store favoritter, men vi har også flere andre systemer i verktøykassen.
Overskrift: Slik velger du riktig regnskapsprogram
CTA: Se mer
(Utdannende/rådgivende innhold, ikke direkte salg.)

[REAI — 16 dager, Bibliotek-ID 1011529941530031]
Hook: Betaler du for mye for regnskap? ReAI er et AI-basert regnskapsprogram, opptil 10x billigere enn konkurrentene. Spar penger uten å gå på kompromiss med kvalitet.
Body: AI-basert regnskapssystem for norske bedrifter. Spar tid, reduser kostnader og få full kontroll, enkelt og effektivt.
CTA: Registrer deg

[FIKEN — 4 dager, Bibliotek-ID 1706880240434220]
Hook: Fiken er et superenkelt regnskapsprogram for små og mellomstore bedrifter.
CTA: Prøv gratis i 30 dager`,
};

export const NICHE_PRESETS: NichePreset[] = [HELSE, EIENDOM, REGNSKAP];

/** Default: health/supplements (matches the Enklereliv/Fulcio case, richest winner set). */
export const DEFAULT_PRESET_ID = HELSE.id;

export function getPreset(id: string): NichePreset | undefined {
  return NICHE_PRESETS.find(p => p.id === id);
}
