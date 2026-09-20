import { useSyncExternalStore } from 'react';
import type { Theme } from './useTheme.js';

/**
 * O tema do painel, com UM estado para a página inteira.
 *
 * O `useTheme.ts` ao lado guarda o tema em `useState`: cada chamada do hook tem
 * o seu. No site e na homepage há um consumidor só, e isso basta. O painel tem
 * três montados ao mesmo tempo — o menu da conta, a paleta de comandos e o
 * canvas —, e quem não tinha feito a troca ficava com o rótulo invertido e
 * gastava o primeiro clique reescrevendo o tema que já estava na tela
 * (`tasks/045`).
 *
 * Mora num arquivo à parte porque `useTheme.ts` é cópia byte a byte do site
 * (`apps/site/src/arquivosCopiados.test.ts`): no painel ele fica só como par
 * dessa cópia e como dono do tipo `Theme`. **No painel, o hook se importa
 * daqui.**
 */

const STORAGE_KEY = 'purple-skills-theme';

/** O que o store precisa do navegador — à parte, para o teste rodar sem DOM. */
export type ThemeHost = {
  /** O tema que está no `<html>` agora. */
  read: () => Theme;
  /** Aplica o tema à página e guarda a escolha. */
  write: (theme: Theme) => void;
};

export function createThemeStore(host: ThemeHost) {
  // Lido no primeiro uso, não na importação: o script inline do `index.html`
  // já escreveu o `data-theme` antes de o módulo carregar, e adiar a leitura
  // deixa o arquivo importável onde não há `document`.
  let theme: Theme | null = null;
  const listeners = new Set<() => void>();

  const get = (): Theme => (theme ??= host.read());

  return {
    get,
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    /** Parte do estado da página, nunca do de quem chamou. */
    toggle(): void {
      theme = get() === 'dark' ? 'light' : 'dark';
      host.write(theme);
      for (const listener of listeners) listener();
    },
  };
}

const store = createThemeStore({
  read: () => (document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light'),
  write: (theme) => {
    const root = document.documentElement;
    root.setAttribute('data-theme', theme);
    // O script do `index.html` escreve também `color-scheme` inline no boot, e
    // inline vence o `color-scheme` que o `tokens.css` declara por tema: sem
    // repetir aqui, barra de rolagem e controles nativos ficavam no tema do boot.
    root.style.colorScheme = theme;
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      // Modo privado ou storage bloqueado: o tema vale só para esta sessão.
    }
  },
});

/** Mesma assinatura do `useTheme` copiado; o estado é o da página. */
export function useTheme(): [Theme, () => void] {
  return [useSyncExternalStore(store.subscribe, store.get), store.toggle];
}
