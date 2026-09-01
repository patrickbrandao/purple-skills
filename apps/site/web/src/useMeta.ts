import { useEffect, useState } from 'react';
import { fetchMeta, type SiteMeta } from './api.js';

let cache: SiteMeta | null = null;

/** Metadados do site (nome, tagline, URL do MCP), buscados uma única vez. */
export function useMeta(): SiteMeta | null {
  const [meta, setMeta] = useState<SiteMeta | null>(cache);

  useEffect(() => {
    if (cache) return;
    let active = true;
    fetchMeta()
      .then((data) => {
        cache = data;
        if (active) setMeta(data);
      })
      .catch(() => void 0);
    return () => {
      active = false;
    };
  }, []);

  return meta;
}
