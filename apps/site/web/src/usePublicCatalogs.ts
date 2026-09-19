import { useEffect, useState } from 'react';
import { fetchPublicCatalogs, type PublicCatalog } from './api.js';

let cache: PublicCatalog[] | null = null;
let inFlight: Promise<PublicCatalog[]> | null = null;

function load(): Promise<PublicCatalog[]> {
  inFlight ??= fetchPublicCatalogs()
    .then((data) => (cache = data.items))
    // Sem catálogos legíveis, o site se comporta como numa instalação sem
    // nenhum: a seção e os atalhos para ela somem.
    .catch(() => (cache = []));
  return inFlight;
}

/**
 * Os catálogos públicos, buscados uma única vez e compartilhados entre a
 * seção, o cabeçalho e a navegação — os dois últimos só mostram o atalho
 * quando há algum. `null` enquanto carrega.
 */
export function usePublicCatalogs(): PublicCatalog[] | null {
  const [items, setItems] = useState<PublicCatalog[] | null>(cache);

  useEffect(() => {
    if (cache) return;
    let active = true;
    void load().then((data) => active && setItems(data));
    return () => {
      active = false;
    };
  }, []);

  return items;
}
