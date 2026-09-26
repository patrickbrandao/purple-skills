import { useEffect, useMemo, useRef, type KeyboardEvent } from 'react';
import { lineCount } from '../explorer.js';
import { languageFor, toCodeLines } from '../highlight.js';
import { cx } from './ui.js';

/**
 * Acima disto o editor volta a ser texto puro: a cor é refeita a cada tecla, e
 * um arquivo grande travaria a digitação. É bem menos que o teto do leitor
 * (`HIGHLIGHT_MAX_CHARS`), que colore uma vez só.
 */
const EDIT_HIGHLIGHT_MAX_CHARS = 60_000;

const INDENT = '  ';
const MODIFIERS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock']);

/**
 * Escreve no campo pelo caminho do navegador: `execCommand` mantém o desfazer
 * (⌘Z) funcionando; onde ele não existe, o texto entra direto e o `input`
 * avisa o React.
 */
function insertText(el: HTMLTextAreaElement, text: string) {
  el.focus();
  if (!document.execCommand('insertText', false, text)) {
    el.setRangeText(text, el.selectionStart, el.selectionEnd, 'end');
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }
}

/** Indenta (ou desindenta) as linhas tocadas pela seleção. */
function indentLines(el: HTMLTextAreaElement, outdent: boolean) {
  const { selectionStart: start, selectionEnd: end, value } = el;
  if (!outdent && start === end) {
    insertText(el, INDENT);
    return;
  }

  const from = value.lastIndexOf('\n', start - 1) + 1;
  // Uma seleção que termina no começo de uma linha não leva essa linha junto.
  const until = end > start && value[end - 1] === '\n' ? end - 1 : end;
  const lineEnd = value.indexOf('\n', until);
  const to = lineEnd === -1 ? value.length : lineEnd;

  const lines = value.slice(from, to).split('\n');
  // Linha vazia não ganha indentação: sobraria espaço no fim dela.
  const changed = lines.map((line) => (outdent ? line.replace(/^( {1,2}|\t)/, '') : line ? INDENT + line : line));
  const block = changed.join('\n');
  if (block === value.slice(from, to)) return;

  el.setSelectionRange(from, to);
  insertText(el, block);
  if (start === end) {
    const caret = Math.max(from, start + changed[0]!.length - lines[0]!.length);
    el.setSelectionRange(caret, caret);
  } else {
    el.setSelectionRange(from, from + block.length);
  }
}

/**
 * O editor de arquivo do painel: um `textarea` com a numeração de linhas ao
 * lado. Sem quebra automática, para cada número corresponder a uma linha de
 * verdade.
 *
 * `Tab` e `Shift+Tab` indentam as linhas, e `Enter` repete a indentação da
 * linha atual. Para sair do campo pelo teclado: `Esc` e depois `Tab`.
 */
export function CodeEditor({
  value,
  onChange,
  readOnly,
  firstLine = 1,
  label,
  placeholder,
  autoFocus,
  className,
  fileName,
}: {
  value: string;
  onChange?: (value: string) => void;
  readOnly?: boolean;
  /** Número da primeira linha — o corpo do SKILL.md começa depois do frontmatter. */
  firstLine?: number;
  label: string;
  placeholder?: string;
  /** Recebe o cursor ao aparecer. */
  autoFocus?: boolean;
  className?: string;
  /**
   * Com o nome do arquivo, o texto sai colorido pela gramática dele — a mesma
   * do leitor (`toCodeLines`). Sem nome, ou com um arquivo grande demais, é
   * texto puro, como sempre foi.
   */
  fileName?: string;
}) {
  const area = useRef<HTMLTextAreaElement>(null);
  const gutter = useRef<HTMLPreElement>(null);
  const paint = useRef<HTMLPreElement>(null);
  const releaseTab = useRef(false);

  // Todas as linhas, sem o corte do leitor: a camada de cor precisa ter a
  // altura exata do texto, senão o fim do arquivo desalinha.
  const code = useMemo(
    () =>
      fileName === undefined
        ? null
        : toCodeLines(value, languageFor(fileName, value), {
            maxLines: Number.POSITIVE_INFINITY,
            maxChars: EDIT_HIGHLIGHT_MAX_CHARS,
          }),
    [fileName, value],
  );
  const colored = code !== null && code.colored;

  const lines = lineCount(value);
  const numbers = useMemo(
    () => Array.from({ length: lines }, (_, index) => firstLine + index).join('\n'),
    [lines, firstLine],
  );

  // A numeração não rola sozinha: a roda sobre ela move o texto, e só ele.
  useEffect(() => {
    const el = gutter.current;
    if (!el) return;
    const forward = (event: WheelEvent) => {
      const target = area.current;
      if (!target) return;
      event.preventDefault();
      const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 20 : 1;
      target.scrollTop += event.deltaY * unit;
      target.scrollLeft += event.deltaX * unit;
    };
    el.addEventListener('wheel', forward, { passive: false });
    return () => el.removeEventListener('wheel', forward);
  }, []);

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (MODIFIERS.has(event.key)) return;
    if (event.key === 'Escape') {
      releaseTab.current = true;
      return;
    }
    const plain = !event.metaKey && !event.ctrlKey && !event.altKey;
    if (event.key === 'Tab' && plain) {
      if (releaseTab.current || readOnly) {
        releaseTab.current = false;
        return;
      }
      event.preventDefault();
      indentLines(event.currentTarget, event.shiftKey);
      return;
    }
    releaseTab.current = false;

    if (event.key === 'Enter' && plain && !event.shiftKey && !readOnly && !event.nativeEvent.isComposing) {
      const el = event.currentTarget;
      if (el.selectionStart !== el.selectionEnd) return;
      const lineStart = el.value.lastIndexOf('\n', el.selectionStart - 1) + 1;
      const indentation = /^[ \t]*/.exec(el.value.slice(lineStart, el.selectionStart))?.[0] ?? '';
      if (indentation) {
        event.preventDefault();
        insertText(el, `\n${indentation}`);
      }
    }
  }

  const textarea = (
    <textarea
      ref={area}
      className="ce-area"
      value={value}
      onChange={(event) => onChange?.(event.target.value)}
      onScroll={(event) => {
        const { scrollTop, scrollLeft } = event.currentTarget;
        if (gutter.current) gutter.current.scrollTop = scrollTop;
        if (paint.current) {
          paint.current.scrollTop = scrollTop;
          paint.current.scrollLeft = scrollLeft;
        }
      }}
      onKeyDown={onKeyDown}
      readOnly={readOnly}
      autoFocus={autoFocus}
      wrap="off"
      spellCheck={false}
      autoCapitalize="off"
      autoCorrect="off"
      aria-label={label}
      placeholder={placeholder}
    />
  );

  return (
    <div className={cx('code-editor', readOnly && 'readonly', colored && 'colored', className)}>
      <pre ref={gutter} className="ce-gutter" aria-hidden="true">
        {numbers}
      </pre>
      {colored ? (
        // A cor fica numa camada **atrás** do campo, com a mesma fonte, o mesmo
        // recuo e a mesma altura de linha; o campo por cima tem o texto
        // transparente e só o cursor e a seleção à vista. É o que deixa editar
        // com cores sem trocar o `textarea` — o desfazer, a seleção e o colar
        // continuam os do navegador.
        <div className="ce-stack">
          <pre ref={paint} className="ce-paint" aria-hidden="true">
            <code className="cv-code">
              {code.lines.map((line, index) => (
                <span key={index}>
                  {line.map((token, at) =>
                    token.className ? (
                      <span key={at} className={token.className}>
                        {token.text}
                      </span>
                    ) : (
                      token.text
                    ),
                  )}
                  {'\n'}
                </span>
              ))}
              {/* A linha em branco do fim, que o `toCodeLines` não conta e o campo mostra. */}
              {value.endsWith('\n') ? ' ' : null}
            </code>
          </pre>
          {textarea}
        </div>
      ) : (
        textarea
      )}
    </div>
  );
}
