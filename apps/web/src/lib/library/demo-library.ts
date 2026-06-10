/**
 * Demo library provider for /library.
 *
 * Same pattern as the other register-surface demo providers:
 * deterministic synthetic data so the surface renders before the
 * library-module backend lands.
 *
 * Distinctive shape: each row is a versioned committee reference
 * document. The viewer surfaces:
 *
 *   - Category (policy / procedure / training material / legislation /
 *     template).
 *   - Version string + last-updated date (versioned docs — no silent
 *     overwrites; superseded versions stay retrievable).
 *   - Language availability (en / fr / both) — Canadian-audience
 *     bilingual posture surfaced per document.
 *   - Offline-cached flag — the library is meant to be readable on
 *     the shop floor beyond cell signal.
 */

export type LibraryCategory = 'policy' | 'procedure' | 'training' | 'legislation' | 'template';
export type LibraryLanguage = 'en' | 'fr' | 'both';

export interface DemoLibraryRow {
  id: string;
  /** Document title. */
  title: string;
  /** Document category. */
  category: LibraryCategory;
  /** Version string, e.g. "v3". */
  version: string;
  /** ISO 8601 timestamp of the last update. */
  updated_at: string;
  /** Language availability. */
  language: LibraryLanguage;
  /** True when the document is cached for offline reading. */
  offline_cached: boolean;
}

export interface DemoLibraryPage {
  rows: DemoLibraryRow[];
  total: number;
  page: number;
  page_size: number;
}

/** Title pools per category so category and title stay coherent. */
const TITLES_BY_CATEGORY: Record<LibraryCategory, readonly string[]> = {
  policy: [
    'Workplace violence and harassment policy',
    'Health and safety policy statement',
    'Hot-work permit policy',
    'Working-alone policy'
  ],
  procedure: [
    'Lockout-tagout procedure',
    'Confined-space entry procedure',
    'Spill response procedure',
    'First-aid response procedure'
  ],
  training: [
    'WHMIS 2015 refresher deck',
    'Certification Part One workbook',
    'Ladder safety toolbox talk',
    'Ergonomic lifting micro-course'
  ],
  legislation: [
    'OHSA — Occupational Health and Safety Act (current consolidation)',
    'O. Reg. 851 — Industrial Establishments',
    'O. Reg. 297/13 — Worker awareness training',
    'WSIA — Workplace Safety and Insurance Act extract'
  ],
  template: [
    'Monthly inspection checklist template',
    'Meeting minutes template',
    'Recommendation letter template',
    'Incident report template'
  ]
};

const CATEGORIES: readonly LibraryCategory[] = [
  'policy',
  'procedure',
  'training',
  'legislation',
  'template'
];

/**
 * Build N deterministic library rows spanning the past 365 days.
 *
 *   - Language: ~50% both / ~40% en / ~10% fr.
 *   - Offline-cached: ~80% true.
 *   - Version: v1..v6.
 */
export function buildDemoLibrary(count: number, seed = 1867): DemoLibraryRow[] {
  let s = seed >>> 0;
  const rand = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const now = Date.now();
  const YEAR_MS = 365 * 24 * 60 * 60 * 1000;
  const rows: DemoLibraryRow[] = [];
  for (let i = 0; i < count; i++) {
    const category = CATEGORIES[Math.floor(rand() * CATEGORIES.length)]!;
    const pool = TITLES_BY_CATEGORY[category];
    const title = pool[Math.floor(rand() * pool.length)]!;
    const ageMs = Math.floor(rand() * YEAR_MS);
    const updated_at = new Date(now - ageMs).toISOString();
    const version = 'v' + (1 + Math.floor(rand() * 6));

    const rl = rand();
    let language: LibraryLanguage;
    if (rl < 0.5) language = 'both';
    else if (rl < 0.9) language = 'en';
    else language = 'fr';

    const offline_cached = rand() < 0.8;

    rows.push({
      id: 'doc-' + i.toString().padStart(6, '0'),
      title,
      category,
      version,
      updated_at,
      language,
      offline_cached
    });
  }
  rows.sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
  return rows;
}

/** Page-based slicer — same contract as the other demo providers. */
export async function fetchDemoLibraryPage(
  page: number,
  page_size: number,
  all: DemoLibraryRow[]
): Promise<DemoLibraryPage> {
  const start = page * page_size;
  return {
    rows: all.slice(start, start + page_size),
    total: all.length,
    page,
    page_size
  };
}
