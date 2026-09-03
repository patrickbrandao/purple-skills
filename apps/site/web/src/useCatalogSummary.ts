import { useEffect, useState } from 'react';
import { fetchTags, searchSkills } from './api.js';

export type CatalogSummary = {
  total: number;
  tags: { name: string; count: number }[];
};

let cache: CatalogSummary | null = null;
let inFlight: Promise<CatalogSummary> | null = null;

function load(): Promise<CatalogSummary> {
  inFlight ??= Promise.all([searchSkills({ limit: 1 }), fetchTags()])
    .then(([skills, tags]) => {
      cache = { total: skills.total, tags: tags.items };
      return cache;
    })
    .catch((err) => {
      inFlight = null;
      throw err;
    });
  return inFlight;
}

/**
 * Total de skills e lista de tags do catálogo, buscados uma única vez e
 * compartilhados entre as seções da home.
 */
export function useCatalogSummary(): CatalogSummary | null {
  const [summary, setSummary] = useState<CatalogSummary | null>(cache);

  useEffect(() => {
    if (cache) return;
    let active = true;
    load()
      .then((data) => active && setSummary(data))
      .catch(() => void 0);
    return () => {
      active = false;
    };
  }, []);

  return summary;
}
