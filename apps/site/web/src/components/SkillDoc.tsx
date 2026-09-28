import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { fileUrl, formatBytes, type SkillFileMeta } from '../api.js';
import { composeSkillMd } from '../frontmatter.js';
import { languageFor, languageLabel, toCodeLines, type CodeLines } from '../highlight.js';
import { useFileText } from '../useFileText.js';
import { CodeView } from './CodeView.js';
import { FileTypeIcon } from './FileTypeIcon.js';
import { Markdown } from './Markdown.js';
import { CheckIcon, CloseIcon, CopyIcon, DownloadIcon } from './Icons.js';

/* ============================================================
   O PROMPT DA SKILL, EM DUAS GUIAS — E O ARQUIVO ABERTO
   "Skill" é a leitura: o markdown renderizado, sem o bloco de
   metadados, que já aparece no cabeçalho da página. "SKILL.md" é
   o arquivo inteiro como ele sai do download — frontmatter e
   corpo — para quem quer copiar e colar num SKILL.md próprio.

   No site, um arquivo escolhido na árvore ao lado abre numa
   terceira guia, com as cores da linguagem, e o SKILL.md cru
   também sai colorido. Nas duas, o Copiar ganha ao lado o ícone
   de baixar o arquivo.

   Diverge do `SkillDoc.tsx` do painel, que continua nas duas
   guias com o SKILL.md em texto puro: lá o arquivo abre na guia
   Arquivos da ficha. NÃO copie um por cima do outro — os ícones
   também diferem (`./Icons.js` aqui, `lucide-react` lá), e
   `Icons.tsx` não existe no painel (docs/04-design-system.md,
   "A caixa do prompt").
   ============================================================ */

/** O que a caixa mostra: o prompt renderizado, o SKILL.md cru ou um arquivo da skill. */
export type DocView = { kind: 'render' } | { kind: 'source' } | { kind: 'file'; file: SkillFileMeta };

type Props = {
  slug: string;
  name: string;
  description: string;
  tags: readonly string[];
  /** Corpo do prompt; os metadados vêm dos campos acima. */
  skillMd: string;
  /** O caminho do SKILL.md no pacote, para o download. */
  skillMdPath: string;
  view: DocView;
  onView: (view: DocView) => void;
};

const VAZIO = '_Esta skill ainda não tem conteúdo em SKILL.md._';

const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1);

const linesLabel = (count: number) => `${count.toLocaleString('pt-BR')} linha${count === 1 ? '' : 's'}`;

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

export function SkillDoc({ slug, name, description, tags, skillMd, skillMdPath, view, onView }: Props) {
  const [copied, setCopied] = useState(false);

  // O frontmatter é montado aqui do mesmo jeito que no servidor: o que está
  // gravado é só o corpo, e os metadados moram em colunas do banco.
  const source = useMemo(
    () => composeSkillMd({ slug, name, description, tags }, skillMd),
    [slug, name, description, tags, skillMd],
  );

  const open = view.kind === 'file' ? view.file : null;
  // Binário não se busca como texto: a caixa mostra a imagem ou o convite a baixar.
  const { file: text, retry } = useFileText(slug, open?.isText ? open.relativePath : null);

  // As linhas coloridas do que está à vista — o SKILL.md cru ou o arquivo aberto.
  const shown = view.kind === 'source' ? source : text?.status === 'ready' ? text.content : null;
  const shownPath = open ? open.relativePath : skillMdPath;
  const code = useMemo(
    () => (view.kind === 'render' || shown === null ? null : toCodeLines(shown, languageFor(shownPath, shown))),
    [view.kind, shown, shownPath],
  );

  useEffect(() => setCopied(false), [view.kind, open?.relativePath]);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  async function copy(value: string) {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
        setCopied(true);
        return;
      }
    } catch {
      // Permissão negada ou contexto sem clipboard: tenta o caminho antigo.
    }

    if (copySync(value)) setCopied(true);
    else window.prompt(`Copie o ${baseName(shownPath)}:`, value);
  }

  const download = view.kind === 'render' ? null : fileUrl(slug, shownPath);

  return (
    <div className="doc-box">
      <div className="doc-tabs">
        <div className="doc-tablist" role="tablist">
          {(
            [
              ['render', 'Skill'],
              ['source', 'SKILL.md'],
            ] as const
          ).map(([kind, label]) => (
            <button
              key={kind}
              type="button"
              role="tab"
              aria-selected={view.kind === kind}
              className={view.kind === kind ? 'active' : ''}
              onClick={() => onView({ kind })}
            >
              {label}
            </button>
          ))}

          {open && (
            <span className="doc-filetab">
              <button type="button" role="tab" aria-selected="true" className="active" title={open.relativePath}>
                <FileTypeIcon fileName={baseName(open.relativePath)} />
                <span className="doc-filetab-name">{baseName(open.relativePath)}</span>
              </button>
              <button
                type="button"
                className="doc-close"
                title="Fechar o arquivo"
                aria-label={`Fechar ${open.relativePath}`}
                onClick={() => onView({ kind: 'render' })}
              >
                <CloseIcon />
              </button>
            </span>
          )}
        </div>

        {download && (
          <div className="doc-actions">
            {shown !== null && (
              <button type="button" className="doc-action" onClick={() => copy(shown)} aria-live="polite">
                {copied ? <CheckIcon /> : <CopyIcon />}
                {copied ? 'Copiado!' : 'Copiar'}
              </button>
            )}
            <a
              href={download}
              download={baseName(shownPath)}
              className="doc-action doc-download"
              title={`Baixar ${baseName(shownPath)}`}
              aria-label={`Baixar ${baseName(shownPath)}`}
            >
              <DownloadIcon />
            </a>
          </div>
        )}
      </div>

      {view.kind === 'render' ? (
        <div className="doc-body">
          <Markdown>{skillMd || VAZIO}</Markdown>
        </div>
      ) : view.kind === 'source' ? (
        <>
          <CodeView code={code!} label="Conteúdo do SKILL.md" />
          <DocFoot path={skillMdPath} code={code!} bytes={new TextEncoder().encode(source).byteLength} />
        </>
      ) : !view.file.isText ? (
        <>
          <BinaryBody slug={slug} file={view.file} />
          <DocFoot path={view.file.relativePath} info={view.file.mimeType} bytes={view.file.sizeBytes} />
        </>
      ) : text?.status === 'error' ? (
        <div className="doc-empty">
          <p>{text.message}</p>
          <button type="button" className="btn btn-ghost btn-sm" onClick={retry}>
            Tentar de novo
          </button>
        </div>
      ) : code === null ? (
        <div className="doc-body doc-skel" aria-busy="true" aria-label="Carregando o arquivo">
          {['42%', '68%', '55%', '74%', '36%', '61%'].map((width, index) => (
            <div key={index} className="skel" style={{ height: '0.8rem', width }} />
          ))}
        </div>
      ) : (
        <>
          {shown === '' ? (
            <div className="doc-empty">
              <p>Arquivo vazio.</p>
            </div>
          ) : (
            <CodeView
              code={code}
              label={`Conteúdo de ${view.file.relativePath}`}
              more={
                code.total > code.lines.length && (
                  <>
                    Mostrando as primeiras {code.lines.length.toLocaleString('pt-BR')} de{' '}
                    {code.total.toLocaleString('pt-BR')} linhas.{' '}
                    <a href={download!} download={baseName(view.file.relativePath)}>
                      Baixe o arquivo
                    </a>{' '}
                    para ler o resto.
                  </>
                )
              }
            />
          )}
          <DocFoot path={view.file.relativePath} code={shown === '' ? null : code} bytes={view.file.sizeBytes} />
        </>
      )}
    </div>
  );
}

/** Arquivo binário: a imagem, quando é uma, ou o convite a baixar. */
function BinaryBody({ slug, file }: { slug: string; file: SkillFileMeta }) {
  const url = fileUrl(slug, file.relativePath);
  if (file.mimeType.startsWith('image/') && file.sizeBytes > 0) {
    return (
      <div className="doc-image">
        <img src={url} alt={`Pré-visualização de ${file.relativePath}`} />
      </div>
    );
  }
  return (
    <div className="doc-empty">
      <p>
        <strong>Arquivo binário</strong> — não dá para mostrar o conteúdo aqui.
      </p>
      <a href={url} download={baseName(file.relativePath)} className="btn btn-ghost btn-sm">
        <DownloadIcon /> Baixar {baseName(file.relativePath)}
      </a>
    </div>
  );
}

/** Rodapé do arquivo à vista: o caminho, e as linhas, a linguagem e o tamanho. */
function DocFoot({
  path,
  code,
  info,
  bytes,
}: {
  path: string;
  code?: CodeLines | null;
  info?: ReactNode;
  bytes: number;
}) {
  const parts = code
    ? [
        linesLabel(code.total),
        languageLabel(code.language),
        ...(code.language && !code.colored ? ['sem cores: grande demais'] : []),
      ]
    : code === null
      ? ['vazio']
      : [];
  return (
    <div className="doc-foot">
      <span className="doc-foot-path" title={path}>
        {path}
      </span>
      <span>
        {[...parts, ...(info ? [info] : []), formatBytes(bytes)].map((part, index) => (
          <span key={index}>
            {index > 0 && ' · '}
            {part}
          </span>
        ))}
      </span>
    </div>
  );
}
