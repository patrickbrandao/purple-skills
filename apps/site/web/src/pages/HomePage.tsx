import { useEffect } from 'react';
import { useMeta } from '../useMeta.js';
import { useReveal } from '../useReveal.js';
import { Hero } from '../components/landing/Hero.js';
import { QuickStart } from '../components/landing/QuickStart.js';
import { HubDiagram } from '../components/landing/HubDiagram.js';
import { PublishFlow } from '../components/landing/PublishFlow.js';
import { Services } from '../components/landing/Services.js';
import { Trinity } from '../components/landing/Trinity.js';
import { Ecosystem } from '../components/landing/Ecosystem.js';
import { Features } from '../components/landing/Features.js';
import { Catalog } from '../components/landing/Catalog.js';
import { Stats } from '../components/landing/Stats.js';
import { Finale } from '../components/landing/Finale.js';

export function HomePage() {
  const meta = useMeta();
  useReveal();

  useEffect(() => {
    document.title = meta ? `${meta.name} — ${meta.tagline}` : 'Purple Skills';
  }, [meta]);

  return (
    <>
      <Hero />
      <QuickStart />
      <HubDiagram />
      <Trinity />
      <PublishFlow />
      <Services />
      <Features />
      <Ecosystem />
      <Catalog />
      <Stats />
      <Finale />
    </>
  );
}
