import { useCallback, useEffect, useRef, useState } from 'react';
import { fileUrl } from './api.js';

/** O conteúdo de um arquivo de texto da skill, como a caixa do prompt o mostra. */
export type FileText =
  | { status: 'loading' }
  | { status: 'ready'; content: string }
  | { status: 'error'; message: string };

async function readText(slug: string, path: string): Promise<string> {
  const response = await fetch(fileUrl(slug, path));
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { message?: string };
    throw new Error(body.message ?? `Falha ao ler o arquivo (${response.status})`);
  }
  return response.text();
}

/**
 * Lê o arquivo aberto, uma vez por caminho: voltar a um arquivo já lido não
 * busca de novo. `null` é "nenhum arquivo". A lembrança é do componente — quem
 * chama troca a `key` quando troca de skill.
 */
export function useFileText(slug: string, path: string | null): { file: FileText | null; retry: () => void } {
  const cache = useRef(new Map<string, string>());
  const [file, setFile] = useState<FileText | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (path === null) {
      setFile(null);
      return;
    }
    const cached = cache.current.get(path);
    if (cached !== undefined) {
      setFile({ status: 'ready', content: cached });
      return;
    }

    let active = true;
    setFile({ status: 'loading' });
    readText(slug, path)
      .then((content) => {
        cache.current.set(path, content);
        if (active) setFile({ status: 'ready', content });
      })
      .catch((err: Error) => active && setFile({ status: 'error', message: err.message }));
    return () => {
      active = false;
    };
  }, [slug, path, attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return { file, retry };
}
