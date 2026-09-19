import type { CSSProperties, ReactNode } from 'react';
import type { CodeLines } from '../highlight.js';
import { cx } from './ui.js';

/**
 * O leitor de arquivo do painel: o código colorido, uma linha por bloco, com
 * a numeração à esquerda. O número é um contador de CSS — não entra na
 * seleção nem no copiar — e fica preso à esquerda quando o texto rola para
 * o lado. Com `wrap`, as linhas longas quebram e o número acompanha a
 * primeira parte.
 *
 * Só desenha: quem chama monta as linhas com `toCodeLines`, e usa o mesmo
 * resultado no rodapé.
 */
export function CodeView({
  code,
  firstLine = 1,
  wrap = false,
  label,
  more,
  className,
}: {
  code: CodeLines;
  /** Número da primeira linha — o corpo do SKILL.md começa depois do frontmatter. */
  firstLine?: number;
  wrap?: boolean;
  label: string;
  /** Aviso depois da última linha, quando o arquivo foi cortado. */
  more?: ReactNode;
  className?: string;
}) {
  const last = firstLine + code.lines.length - 1;
  const style = { '--cv-digits': String(last).length } as CSSProperties;

  return (
    // Rolável pelo teclado: o foco fica no leitor, que não tem outro controle.
    <div className={cx('code-view', wrap && 'wrap', className)} style={style} tabIndex={0} role="region" aria-label={label}>
      <pre className="cv-pre">
        <code className="cv-code" style={{ counterReset: `cv-line ${firstLine - 1}` }}>
          {code.lines.map((line, index) => (
            <span key={index} className="cv-line">
              <span className="cv-text">
                {line.map((token, at) =>
                  token.className ? (
                    <span key={at} className={token.className}>
                      {token.text}
                    </span>
                  ) : (
                    token.text
                  ),
                )}
              </span>
            </span>
          ))}
        </code>
      </pre>
      {more && <p className="cv-more">{more}</p>}
    </div>
  );
}
