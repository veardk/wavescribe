// Language codes. Users write BCP-47 (`zh`, `zh-CN`, `en`, `yue`); each provider maps further.

const NAME_TO_CODE: Record<string, string> = {
  chinese: "zh",
  mandarin: "zh",
  english: "en",
  japanese: "ja",
  korean: "ko",
  french: "fr",
  german: "de",
  spanish: "es",
  portuguese: "pt",
  italian: "it",
  russian: "ru",
  arabic: "ar",
  hindi: "hi",
  vietnamese: "vi",
  thai: "th",
  indonesian: "id",
  turkish: "tr",
  dutch: "nl",
  polish: "pl",
  ukrainian: "uk",
  cantonese: "yue",
  malay: "ms",
  swedish: "sv",
};

/** ISO-639-3 / -2 codes some vendors return (ElevenLabs, Speechmatics). */
const ISO3: Record<string, string> = {
  cmn: "zh",
  zho: "zh",
  chi: "zh",
  eng: "en",
  jpn: "ja",
  kor: "ko",
  fra: "fr",
  fre: "fr",
  deu: "de",
  ger: "de",
  spa: "es",
  por: "pt",
  ita: "it",
  rus: "ru",
  ara: "ar",
  hin: "hi",
  vie: "vi",
  tha: "th",
  ind: "id",
  tur: "tr",
  nld: "nl",
  dut: "nl",
  pol: "pl",
  ukr: "uk",
  msa: "ms",
  may: "ms",
  swe: "sv",
};

const CODE_TO_NAME: Record<string, string> = Object.fromEntries(
  Object.entries(NAME_TO_CODE)
    .filter(([n]) => n !== "mandarin")
    .map(([n, c]) => [c, n]),
);

/** Normalise whatever a user or provider gave us into a short BCP-47 tag. */
export function normalizeLanguage(input: string | undefined | null): string | undefined {
  if (!input) return undefined;
  const raw = String(input).trim();
  if (!raw) return undefined;
  const lower = raw.toLowerCase();
  if (NAME_TO_CODE[lower]) return NAME_TO_CODE[lower];
  if (ISO3[lower]) return ISO3[lower];
  const cleaned = raw.replace(/_/g, "-").replace(/^ai-/i, "");
  const [base, region] = cleaned.split("-");
  if (!base || !/^[a-z]{2,3}$/i.test(base)) return undefined;
  if (region && /^(hans|hant|[a-z]{2})$/i.test(region)) {
    const r = region.length === 2 ? region.toUpperCase() : region[0]!.toUpperCase() + region.slice(1).toLowerCase();
    return `${base.toLowerCase()}-${r}`;
  }
  return base.toLowerCase();
}

/** `zh-CN` → `zh` */
export const baseLanguage = (lang: string | undefined): string | undefined => lang?.split("-")[0]?.toLowerCase();

/** `zh` → `chinese` (Lemonfox and some APIs want English names). */
export const languageName = (lang: string | undefined): string | undefined => {
  const b = baseLanguage(lang);
  return b ? CODE_TO_NAME[b] : undefined;
};
