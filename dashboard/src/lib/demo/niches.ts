// Fulcio demo — niche presets.
//
// Spec v2's core idea: ONE generic engine, niche-tailored OUTPUT, because the
// INPUT is real niche-specific winning ads (not a template). Each preset carries
// a brief + that niche's winning-ad examples (the husstil-grounding). The demo
// opens on a preset with one click; Sondre can edit any field or paste his own.
//
// `provenance` is shown in the UI so we never present illustrative copy as real
// ads (honest-pitch discipline from the spec). Research swaps the illustrative
// presets for real pre-fetched niche-winners as they land.

export type Provenance = 'illustrative' | 'real-verified';

export interface NichePreset {
  id: string;
  label: string;
  provenance: Provenance;
  /** One-line note shown in the UI about what is real vs illustrative. */
  provenanceNote: string;
  produkt: string;
  maalgruppe: string;
  tilbud: string;
  plattform: string;
  husstil_eksempler: string;
}

// Option B — flawless illustrative default (zero dependency). From
// demo-example-campaign.md. Clearly labelled illustrative; never shown as real ads.
const NORDREST: NichePreset = {
  id: 'kosttilskudd',
  label: 'Kosttilskudd / restitusjon (illustrativt)',
  provenance: 'illustrative',
  provenanceNote: 'Oppdiktet illustrasjon modellert på Fulcios faktiske vertikal (kosttilskudd, menn 25-40, social proof). Ikke ekte annonser.',
  produkt: 'NORDREST (illustrativt): norsk kosttilskudd for restitusjon og energi',
  maalgruppe: 'Menn 25-40, trener regelmessig, sliter med energi og restitusjon',
  tilbud: '30-dagers prøvepakke, social proof med ekte brukerresultater',
  plattform: 'TikTok',
  husstil_eksempler: `ANNONSE 1 (social proof / ekte resultat):
Hook: "Jeg trodde norske kosttilskudd var bortkastede penger. Så kom uke 3."
Body: Viser dag 1 vs dag 21. Samme trening, samme søvn. Forskjellen var restitusjonen. Jeg våkner ikke lenger knust etter beinøkt.
CTA: "Prøv 30 dager. Kjenn forskjellen selv, eller få pengene tilbake."

ANNONSE 2 (problem-agitate):
Hook: "Hvis du kræsjer klokka 14 hver dag, er det ikke viljestyrken det er noe galt med."
Body: Det er restitusjon. Kroppen din henger etter. Ett norsk-produsert tilskudd, tatt om morgenen, og ettermiddags-dippen forsvant.
CTA: "Se hvorfor 8000 nordmenn byttet. Lenke i bio."

ANNONSE 3 (before/after transformasjon):
Hook: "30 dager. Samme program. Helt annen kropp å trene med."
Body: Ikke mer energi på papiret. Mer energi i beina, i fjerde sett, på den fjerde dagen på rad. Det er der det teller.
CTA: "Start prøvepakken i dag."`,
};

// Option A — real Fulcio client (Enklereliv). Brief fields are verified-public
// (fulciomedia.no); the husstil examples are illustrative-in-Fulcio's-style and
// labelled as such (verbatim ads require video transcription, a 5-min manual prep).
const ENKLERELIV: NichePreset = {
  id: 'wellness',
  label: 'Wellness — Enklereliv (ekte Fulcio-kunde)',
  provenance: 'real-verified',
  provenanceNote: 'Brief-feltene er VERIFISERT-OFFENTLIG (Fulcio-kunde, wellness, 5x ROAS, 50% av Meta-salg fra innhold). Husstil-eksemplene er illustrative i Fulcios verifiserte stil, ikke deres verbatim ads.',
  produkt: 'Enklereliv (wellness): Fulcio-kunde, wellness-vertikal, resultat "50% av Meta-salg fra innhold, 5x ROAS"',
  maalgruppe: 'Helse- og wellness-bevisste forbrukere, 25-45',
  tilbud: 'Social proof med ekte brukerresultater, bold påstand + visuelt bevis',
  plattform: 'Meta',
  husstil_eksempler: `ILLUSTRATIVT EKSEMPEL 1 (social proof, bold påstand + visuelt bevis):
Hook: "Jeg ga den 14 dager før jeg ga opp. Jeg ga aldri opp."
Body: Viser hverdagen før og etter. Ikke en mirakel-historie, bare en som faktisk holdt.
CTA: "Se hva 14 dager gjør. Lenke i bio."

ILLUSTRATIVT EKSEMPEL 2 (ekte-bruker-vinkel):
Hook: "Ingen betalte meg for å si dette, og det er litt av poenget."
Body: Ekte bruker, ekte hverdag, ekte forskjell. Det er derfor det funker.
CTA: "Prøv det selv."`,
};

export const NICHE_PRESETS: NichePreset[] = [NORDREST, ENKLERELIV];

/** The preset the demo opens on (flawless, zero-dependency illustrative default). */
export const DEFAULT_PRESET_ID = NORDREST.id;

export function getPreset(id: string): NichePreset | undefined {
  return NICHE_PRESETS.find(p => p.id === id);
}
