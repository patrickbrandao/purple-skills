import { useEffect, useState } from 'react';
import { fetchTags, searchSkills } from './api.js';

export type SkillsSummary = {
  total: number;
  tags: { name: string; count: number }[];
};

let cache: SkillsSummary | null = null;
let inFlight: Promise<SkillsSummary> | null = null;

function load(): Promise<SkillsSummary> {
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
 * Total de skills públicas e lista de tags, buscados uma única vez e
 * compartilhados entre as seções da home.
 */
export function useSkillsSummary(): SkillsSummary | null {
  const [summary, setSummary] = useState<SkillsSummary | null>(cache);

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
