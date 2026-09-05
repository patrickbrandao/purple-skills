import { Layout } from './components/Layout.js';
import { useReveal } from './useReveal.js';
import { Hero } from './components/landing/Hero.js';
import { QuickStart } from './components/landing/QuickStart.js';
import { HubDiagram } from './components/landing/HubDiagram.js';
import { Trinity } from './components/landing/Trinity.js';
import { PublishFlow } from './components/landing/PublishFlow.js';
import { Services } from './components/landing/Services.js';
import { Features } from './components/landing/Features.js';
import { Ecosystem } from './components/landing/Ecosystem.js';
import { Stats } from './components/landing/Stats.js';
import { Finale } from './components/landing/Finale.js';

/**
 * Página única de apresentação do projeto.
 *
 * Sem rotas e sem chamadas de rede: a homepage não conhece nenhuma instalação
 * do Purple Skills, ela só explica o projeto e leva o visitante ao GitHub.
 */
export default function App() {
  useReveal();

  return (
    <Layout>
      <Hero />
      <QuickStart />
      <HubDiagram />
      <Trinity />
      <PublishFlow />
      <Services />
      <Features />
      <Ecosystem />
      <Stats />
      <Finale />
    </Layout>
  );
}
