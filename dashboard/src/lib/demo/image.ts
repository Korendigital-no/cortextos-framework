// Fulcio demo — P5 static-ad image generation (stretch / visual finale).
//
// Generates one static social-ad mockup for the chosen concept, in the niche's
// style. On-demand (a button in the result view), NOT part of the ~60s pipeline:
// GPT Image takes ~40s, so keeping it out of the flow keeps the core fast.
//
// Model: gpt-image-1.5 (smoke-tested 2026-06-03; gpt-image-1 deprecates Oct 2026,
// per research). Image-model ids change — keep this constant in one place.
//
// Uses the existing OPENAI_API_KEY (same key as the text pipeline). When/if image
// generation moves to another provider, only this file changes.

import { staticAdImagePrompt } from './prompts';

const GPT_IMAGE_MODEL = 'gpt-image-1.5';

export interface StaticAdResult {
  /** data: URL (base64 PNG) ready to drop into an <img src>. */
  dataUrl: string;
  model: string;
  prompt: string;
}

export async function generateStaticAd(opts: {
  produkt: string;
  plattform: string;
  conceptTitle: string;
}): Promise<StaticAdResult> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY not configured');

  const prompt = staticAdImagePrompt(opts.produkt, opts.plattform, opts.conceptTitle);

  const res = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: GPT_IMAGE_MODEL,
      prompt,
      size: '1024x1024',
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Image gen ${res.status}: ${body.slice(0, 300)}`);
  }

  const json = await res.json();
  const b64 = json?.data?.[0]?.b64_json;
  if (typeof b64 !== 'string') throw new Error('Image API returned no image data');

  return { dataUrl: `data:image/png;base64,${b64}`, model: GPT_IMAGE_MODEL, prompt };
}
