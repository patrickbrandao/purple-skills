import type { CSSProperties, ReactNode } from 'react';
import type { CodeLines } from '../highlight.js';

/**
 * O leitor de arquivo da caixa do prompt: o código colorido, uma linha por
 * bloco, com a numeração à esquerda. O número é um contador de CSS — não
 * entra na seleção nem no copiar. As linhas longas quebram, e o número
 * acompanha a primeira parte.
 *
 * Só desenha: quem chama monta as linhas com `toCodeLines`, e usa o mesmo
 * resultado no rodapé. É o `CodeView` do painel sem a opção de não quebrar
 * as linhas — não é cópia, porque o do painel depende dos primitivos dele.
 */
export function CodeView({ code, label, more }: { code: CodeLines; label: string; more?: ReactNode }) {
  const style = { '--cv-digits': String(code.lines.length).length } as CSSProperties;

  return (
    <div className="code-view" style={style} role="region" aria-label={label}>
      <pre className="cv-pre">
        <code className="cv-code">
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
