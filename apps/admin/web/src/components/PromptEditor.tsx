import { useState, type CSSProperties } from 'react';
import { Markdown } from './Markdown.js';

type Pane = 'split' | 'edit' | 'preview';

const PANES = [
  ['split', 'Lado a lado'],
  ['edit', 'Escrever'],
  ['preview', 'Visualizar'],
] as const;

/**
 * Editor do prompt da skill: markdown à esquerda, render à direita, lado a
 * lado e em tempo real. Em tela estreita o lado a lado não cabe — o CSS
 * empilha os dois painéis, e os botões trocam entre escrever e ver.
 *
 * Aqui entra só o corpo do prompt: os metadados ficam no formulário acima e
 * viram as primeiras linhas do SKILL.md na leitura.
 */
export function PromptEditor({
  value,
  onChange,
  rows = 26,
}: {
  value: string;
  onChange: (value: string) => void;
  rows?: number;
}) {
  const [pane, setPane] = useState<Pane>('split');

  return (
    // `--prompt-rows` deixa o painel de render com a mesma altura do textarea.
    <div className={`prompt-editor pane-${pane}`} style={{ '--prompt-rows': rows } as CSSProperties}>
      <div className="head">
        <span className="label">Prompt da skill (markdown)</span>
        <div className="segmented segmented-sm">
          {PANES.map(([option, label]) => (
            <button
              key={option}
              type="button"
              className={pane === option ? 'active' : ''}
              onClick={() => setPane(option)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="panes">
        <div className="pane edit">
          <span className="cap">Markdown</span>
          <textarea
            value={value}
            onChange={(event) => onChange(event.target.value)}
            rows={rows}
            spellCheck={false}
            className="field field-mono resize-y"
            placeholder={'# Título\n\n## Quando usar\n\nDescreva o gatilho da skill.'}
          />
        </div>

        <div className="pane preview">
          <span className="cap">Pré-visualização</span>
          <div className="render">
            {value.trim() ? (
              <Markdown>{value}</Markdown>
            ) : (
              <p className="list-empty">O markdown escrito ao lado aparece aqui, renderizado.</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
