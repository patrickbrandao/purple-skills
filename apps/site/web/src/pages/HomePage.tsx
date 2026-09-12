import { useEffect } from 'react';
import { useMeta } from '../useMeta.js';
import { useReveal } from '../useReveal.js';
import { Masthead } from '../components/catalog/Masthead.js';
import { Connect } from '../components/catalog/Connect.js';
import { ConnectAdmin } from '../components/catalog/ConnectAdmin.js';
import { Endpoints } from '../components/catalog/Endpoints.js';
import { OpenMcps } from '../components/catalog/OpenMcps.js';
import { Catalog } from '../components/catalog/Catalog.js';

export function HomePage() {
  const meta = useMeta();
  useReveal();

  useEffect(() => {
    document.title = meta ? `${meta.name} — ${meta.tagline}` : 'Purple Skills';
  }, [meta]);

  return (
    <>
      <Masthead />
      <Catalog />
      <Connect />
      <OpenMcps />
      <ConnectAdmin />
      <Endpoints />
    </>
  );
}
