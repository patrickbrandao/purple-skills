import { useEffect, useState } from 'react';
import { fetchMeta, type SiteMeta } from './api.js';

let cache: SiteMeta | null = null;
let inFlight: Promise<SiteMeta> | null = null;

/**
 * A home monta seis consumidores no mesmo commit (o layout, a página e quatro
 * seções): sem guardar a busca em voo, cada um dispararia a sua, porque o
 * `cache` só existe depois da resposta. Mesmo padrão de `useSkillsSummary` e
 * `usePublicCatalogs`.
 */
function load(): Promise<SiteMeta> {
  inFlight ??= fetchMeta()
    .then((data) => (cache = data))
    .catch((err) => {
      // Zera para que a próxima montagem tente de novo: uma falha de rede na
      // primeira carga não pode congelar a busca pelo resto da sessão.
      inFlight = null;
      throw err;
    });
  return inFlight;
}

/** Metadados do site (nome, tagline, URL do MCP), buscados uma única vez. */
export function useMeta(): SiteMeta | null {
  const [meta, setMeta] = useState<SiteMeta | null>(cache);

  useEffect(() => {
    if (cache) return;
    let active = true;
    load()
      .then((data) => {
        if (active) setMeta(data);
      })
      .catch(() => void 0);
    return () => {
      active = false;
    };
  }, []);

  return meta;
}
