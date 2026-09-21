import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { useMeta } from '../useMeta.js';
import { useReveal } from '../useReveal.js';
import { Masthead } from '../components/home/Masthead.js';
import { Connect } from '../components/home/Connect.js';
import { ConnectAdmin } from '../components/home/ConnectAdmin.js';
import { Endpoints } from '../components/home/Endpoints.js';
import { OpenMcps } from '../components/home/OpenMcps.js';
import { PublicCatalogs } from '../components/home/PublicCatalogs.js';
import { PublicSkills } from '../components/home/PublicSkills.js';

export function HomePage() {
  const meta = useMeta();
  const { hash } = useLocation();
  useReveal();

  useEffect(() => {
    document.title = meta ? `${meta.name} — ${meta.tagline}` : 'Purple Skills';
  }, [meta]);

  // Quem volta de uma skill ou de um catálogo chega por `/#skills` ou
  // `/#catalogs`. A seção dos catálogos só existe depois da busca, e a grade
  // de skills acima dela muda de altura ao trocar o esqueleto pelos cartões:
  // espera as duas coisas antes de pular. O salto é seco, como o de uma
  // âncora ao carregar a página — o `smooth` do base.css é para quem já está nela.
  useEffect(() => {
    if (!hash) return;
    let tries = 0;
    const timer = setInterval(() => {
      const target = document.getElementById(decodeURIComponent(hash.slice(1)));
      const ready = target !== null && !document.querySelector('.skel');
      if (ready) target.scrollIntoView({ block: 'start', behavior: 'instant' });
      if (ready || ++tries >= 60) clearInterval(timer);
    }, 50);
    return () => clearInterval(timer);
  }, [hash]);

  return (
    <>
      <Masthead />
      <PublicSkills />
      <PublicCatalogs />
      <Connect />
      <OpenMcps />
      <ConnectAdmin />
      <Endpoints />
    </>
  );
}
