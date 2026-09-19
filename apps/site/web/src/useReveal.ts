import { useEffect } from 'react';

/**
 * Revela os elementos `.reveal` conforme entram na viewport.
 *
 * Alcança também os que nascem depois da primeira passagem — a grade de
 * skills, os cartões de catálogo, a seção inteira dos servidores abertos —,
 * por um observador de mutações: sem ele, uma parte que só existe quando a
 * busca responde ocupa espaço na página e nunca aparece. `deps` continua
 * reobservando quando o React reescreve a `className` de um elemento já
 * revelado (a paginação, por exemplo).
 */
export function useReveal(deps: unknown[] = []) {
  useEffect(() => {
    if (!('IntersectionObserver' in window)) {
      document.querySelectorAll<HTMLElement>('.reveal').forEach((el) => el.classList.add('in'));
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add('in');
            observer.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.12, rootMargin: '0px 0px -6% 0px' },
    );

    const observeAll = (root: HTMLElement) => {
      if (root.matches('.reveal:not(.in)')) observer.observe(root);
      root.querySelectorAll<HTMLElement>('.reveal:not(.in)').forEach((el) => observer.observe(el));
    };

    observeAll(document.body);

    const mutations = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node instanceof HTMLElement) observeAll(node);
        }
      }
    });
    mutations.observe(document.body, { childList: true, subtree: true });

    return () => {
      mutations.disconnect();
      observer.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}
