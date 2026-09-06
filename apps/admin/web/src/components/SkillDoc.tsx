import { useEffect, useMemo, useState } from 'react';
import { composeSkillMd } from '../frontmatter.js';
import { Markdown } from './Markdown.js';
import { CheckIcon, CopyIcon } from './Icons.js';

/* ============================================================
   O PROMPT DA SKILL, EM DUAS GUIAS
   "Skill" é a leitura: o markdown renderizado, sem o bloco de
   metadados, que já aparece no cabeçalho da página. "SKILL.md" é
   o arquivo inteiro como ele sai do download — frontmatter e
   corpo — para quem quer copiar e colar num SKILL.md próprio.

   Cópia idêntica em `apps/site` e `apps/admin` — ao mexer, copie.
   ============================================================ */

type Props = {
  slug: string;
  name: string;
  description: string;
  tags: readonly string[];
  /** Corpo do prompt; os metadados vêm dos campos acima. */
  skillMd: string;
};

type Tab = 'render' | 'source';

const VAZIO = '_Esta skill ainda não tem conteúdo em SKILL.md._';

export function SkillDoc({ slug, name, description, tags, skillMd }: Props) {
  const [tab, setTab] = useState<Tab>('render');
  const [copied, setCopied] = useState(false);

  // O frontmatter é montado aqui do mesmo jeito que no servidor: o que está
  // gravado é só o corpo, e os metadados moram em colunas do banco.
  const source = useMemo(
    () => composeSkillMd({ slug, name, description, tags }, skillMd),
    [slug, name, description, tags, skillMd],
  );

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  /** Caminho antigo, ainda útil quando a API assíncrona é negada. */
  function copySync(text: string): boolean {
    try {
      const area = document.createElement('textarea');
      area.value = text;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(area);
      return ok;
    } catch {
      return false;
    }
  }

  async function copy() {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(source);
        setCopied(true);
        return;
      }
    } catch {
      // Permissão negada ou contexto sem clipboard: tenta o caminho antigo.
    }

    if (copySync(source)) setCopied(true);
    else window.prompt('Copie o SKILL.md:', source);
  }

  return (
    <div className="doc-box">
      <div className="doc-tabs" role="tablist">
        {(
          [
            ['render', 'Skill'],
            ['source', 'SKILL.md'],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={tab === value}
            className={tab === value ? 'active' : ''}
            onClick={() => setTab(value)}
          >
            {label}
          </button>
        ))}

        {tab === 'source' && (
          <button type="button" className="doc-copy" onClick={copy} aria-live="polite">
            {copied ? <CheckIcon /> : <CopyIcon />}
            {copied ? 'Copiado!' : 'Copiar'}
          </button>
        )}
      </div>

      {tab === 'render' ? (
        <div className="doc-body">
          <Markdown>{skillMd || VAZIO}</Markdown>
        </div>
      ) : (
        <pre className="doc-source">
          <code>{source}</code>
        </pre>
      )}
    </div>
  );
}
