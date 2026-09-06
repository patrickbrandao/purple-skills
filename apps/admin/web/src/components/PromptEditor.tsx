import { useCallback, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { Markdown } from './Markdown.js';
import { syncedScrollTop } from '../scrollsync.js';

type Pane = 'split' | 'edit' | 'preview';
type Side = 'edit' | 'preview';

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

  const editorRef = useRef<HTMLTextAreaElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  /** Painel que o usuário está movendo — só ele comanda a rolagem do outro. */
  const leader = useRef<Side>('edit');

  /** Alinha o painel seguidor à fração rolada do painel que manda. */
  const sync = useCallback((from: Side) => {
    const editor = editorRef.current;
    const preview = previewRef.current;
    if (!editor || !preview) return;

    const [lead, follow] = from === 'edit' ? [editor, preview] : [preview, editor];
    const top = syncedScrollTop(lead, follow);
    if (top !== null) follow.scrollTop = top;
  }, []);

  // Espelhar os dois sentidos ao mesmo tempo faria um painel puxar o outro em
  // laço: a rolagem que este handler provoca no seguidor volta como evento.
  // Por isso só o painel com que o usuário interagiu por último comanda.
  const onScroll = (from: Side) => () => {
    if (leader.current === from) sync(from);
  };

  const claim = (from: Side) => {
    const take = () => {
      leader.current = from;
    };
    return { onPointerEnter: take, onWheel: take, onTouchStart: take, onFocus: take };
  };

  // Realinhar depois de o conteúdo mudar (digitar altera a altura do render) e
  // ao voltar de "Escrever"/"Visualizar", que deixam os painéis em posições
  // diferentes. `useLayoutEffect` porque isto é medir e corrigir rolagem: ler
  // as alturas aqui força o cálculo do layout já atualizado, e o ajuste entra
  // antes do desenho — sem o quadro de desalinho que um efeito comum mostraria.
  useLayoutEffect(() => {
    if (pane !== 'split') return;
    sync(leader.current);
  }, [value, pane, sync]);

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
            ref={editorRef}
            value={value}
            onChange={(event) => {
              // Digitar é interagir com o markdown, mesmo que o ponteiro tenha
              // parado sobre a visualização: quem escreve comanda a rolagem.
              leader.current = 'edit';
              onChange(event.target.value);
            }}
            onScroll={onScroll('edit')}
            {...claim('edit')}
            rows={rows}
            spellCheck={false}
            className="field field-mono resize-y"
            placeholder={'# Título\n\n## Quando usar\n\nDescreva o gatilho da skill.'}
          />
        </div>

        <div className="pane preview">
          <span className="cap">Pré-visualização</span>
          <div className="render" ref={previewRef} onScroll={onScroll('preview')} {...claim('preview')}>
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
