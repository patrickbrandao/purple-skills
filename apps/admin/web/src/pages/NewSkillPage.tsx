import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { AlertTriangle, FileArchive, ShieldQuestion, Sparkles, Upload } from 'lucide-react';
import {
  createSkill,
  importToQuarantine,
  importZip,
  num,
  plural,
  type BundleSkipped,
  type QuarantineBundleResult,
  type SkillLinkInput,
} from '../api.js';
import { Button, Panel } from '../components/ui.js';
import { FrontmatterPreview, SkillMetaForm, type SkillMetaValues } from '../components/SkillMetaForm.js';
import { PublishInPicker } from '../components/SkillMcps.js';
import { PromptEditor } from '../components/PromptEditor.js';
import { parseTags, stripFrontmatter } from '../frontmatter.js';
import { slugify } from '../slug.js';
import { useToast } from '../components/Toast.js';

/** Só o corpo: o frontmatter é gerado a partir dos campos do formulário. */
const TEMPLATE = `# Minha Skill

## Quando usar

Descreva o gatilho: em que situação o agente deve aplicar esta skill.

## Passos

1. Primeiro passo
2. Segundo passo

## Exemplo

\`\`\`bash
echo "exemplo"
\`\`\`
`;

/** Onde o pacote importado cai (`docs/15-quarentena.md`). */
type Destino = 'producao' | 'quarentena';

/**
 * Os formatos aceitos, do jeito que a tela os escreve: a mesma lista do
 * `FORMATOS_ACEITOS` de `packages/shared/src/archive.ts`, que é a que o
 * servidor cita ao recusar um pacote. A tela enumerava metade dela (`.zip`,
 * `.skill`, `.tar`, `.tar.gz`, `.tar.zst`), e quem tinha um `.zstd` lia que o
 * formato não servia — embora sirva.
 */
export const FORMATOS_NA_TELA = '.zip, .skill, .tar, .tar.gz, .tgz, .gz, .tar.zst, .tzst, .zst e .zstd';

/**
 * O `accept` do seletor de arquivo.
 *
 * O navegador compara a extensão **inteira**, não o pedaço depois do último
 * ponto: `.gz` cobre `.tar.gz` porque o nome termina em `.gz`, mas `.zst` não
 * cobre `.zstd` coisa nenhuma. Medido: com o `accept` antigo, um pacote
 * `.zstd` — que o servidor abre — ficava invisível no diálogo de arquivo. Por
 * isso cada sufixo está aqui por extenso, inclusive o `.gzip`, que o
 * `archive.ts` também desembrulha mas não enumera na mensagem de recusa. Quem
 * decide de verdade continua sendo o servidor, pela assinatura do arquivo.
 */
export const ACCEPT_PACOTE = '.zip,.skill,.tar,.tar.gz,.tgz,.gz,.gzip,.tar.zst,.tzst,.zst,.zstd,application/zip';

/**
 * Por que uma skill do pacote não virou envio, em português.
 *
 * É um `Record` da união, e não um `switch` com saída genérica, para que um
 * motivo novo no `BundleSkipped` do pacote compartilhado pare a compilação
 * aqui — motivo sem texto viraria célula vazia, que é o mesmo que esconder a
 * skill recusada. O número de arquivos não entra na frase: ele vem do corpo da
 * resposta e tem coluna própria; o teto é do servidor e não chega até aqui.
 */
export const MOTIVO_PULADA: Record<BundleSkipped['reason'], string> = {
  too_many_files: 'Passou do teto de arquivos por skill',
};

/**
 * O que um pacote com **várias** skills deixou na quarentena.
 *
 * É tela, e não aviso que some: quem acabou de importar 40 skills de um
 * repositório de terceiro precisa conferir o que entrou contra o que enviou, e
 * quatro segundos de toast não dão para isso. Cada linha leva ao envio; o que
 * ficou de fora aparece separado, com o motivo — e, se não ficou nada de fora,
 * a seção não existe, porque caixa vazia não é estado vazio.
 *
 * Também é esta tela quando o pacote trazia uma skill só e ela foi pulada: o
 * servidor responde bundle porque é o único corpo com onde dizer o que não
 * entrou. Daí as duas listas serem opcionais, cada uma por sua conta.
 */
function BundleResult({
  resultado,
  onNovoPacote,
}: {
  resultado: QuarantineBundleResult;
  onNovoPacote: () => void;
}) {
  const { imported, skipped, sourceFilename } = resultado;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Pacote importado</h1>
          <p className="sub">
            {imported.length > 0
              ? 'Cada skill do pacote virou um envio na quarentena, esperando aprovação. Nada foi publicado, indexado nem aparece no site.'
              : 'Nenhuma skill do pacote entrou na quarentena. Abaixo está o que impediu cada uma.'}
          </p>
        </div>
      </div>

      <div className="meta-line">
        <span className="stat">
          <FileArchive />
          <span className="mono">{sourceFilename}</span>
        </span>
        <span className="sep" />
        <span className="stat">
          <ShieldQuestion />
          {plural(imported.length, 'skill entrou na quarentena', 'skills entraram na quarentena')}
        </span>
        {skipped.length > 0 && (
          <>
            <span className="sep" />
            <span className="stat">
              <AlertTriangle />
              {plural(skipped.length, 'skill ficou de fora', 'skills ficaram de fora')}
            </span>
          </>
        )}
      </div>

      {imported.length > 0 && (
        <Panel title="Na quarentena" icon={<ShieldQuestion />}>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Envio</th>
                  <th className="num hidden sm:table-cell">Arquivos</th>
                </tr>
              </thead>
              <tbody>
                {imported.map((item) => (
                  <tr key={item.uuid}>
                    <td>
                      <Link to={`/quarentena/${item.uuid}`} className="flex items-center gap-3 no-underline">
                        <span className="skill-icon sm" aria-hidden="true">
                          <FileArchive size={14} />
                        </span>
                        <span className="min-w-0">
                          <span className="row-title">{item.name}</span>
                          <span className="row-sub mono">{item.path || 'raiz do pacote'}</span>
                        </span>
                      </Link>
                    </td>
                    <td className="num hidden sm:table-cell">{num(item.fileCount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      )}

      {skipped.length > 0 && (
        <Panel className={imported.length > 0 ? 'mt-4' : ''} title="Ficaram de fora" icon={<AlertTriangle />}>
          <p className="panel-hint mb-3">
            {imported.length > 0
              ? 'O resto do pacote entrou. Estas não viraram envio e continuam só no arquivo que você enviou.'
              : 'Nenhuma delas virou envio: continuam só no arquivo que você enviou.'}
          </p>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Caminho no pacote</th>
                  <th>Motivo</th>
                  <th className="num hidden sm:table-cell">Arquivos</th>
                </tr>
              </thead>
              <tbody>
                {skipped.map((item) => (
                  <tr key={item.path}>
                    <td>
                      <span className="row-title mono">{item.path || 'raiz do pacote'}</span>
                    </td>
                    <td>{MOTIVO_PULADA[item.reason]}</td>
                    <td className="num hidden sm:table-cell">{num(item.fileCount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      )}

      <div className="mt-4 flex justify-end gap-2">
        <Button variant="ghost" onClick={onNovoPacote}>
          <Upload /> Importar outro pacote
        </Button>
        {/* `Link`, não `Button` dentro de `Link`: botão dentro de âncora é
            aninhamento inválido, e o clique do teclado fica ambíguo. */}
        <Link to="/quarentena" className="btn btn-primary">
          <ShieldQuestion /> Ver a fila da quarentena
        </Link>
      </div>
    </div>
  );
}

export function NewSkillPage() {
  const navigate = useNavigate();
  const toast = useToast();
  const [params] = useSearchParams();

  const [mode, setMode] = useState<'form' | 'zip'>(params.get('modo') === 'zip' ? 'zip' : 'form');
  // O destino só existe na importação: o formulário vai sempre para produção.
  const [destino, setDestino] = useState<Destino>(params.get('destino') === 'quarentena' ? 'quarentena' : 'producao');
  const [meta, setMeta] = useState<SkillMetaValues>({ name: '', slug: '', description: '', tags: '', icon: '' });
  // Onde publicar já na criação. Vazio = a skill nasce flutuante.
  const [links, setLinks] = useState<SkillLinkInput[]>([]);
  // Enquanto o slug não for editado à mão, ele acompanha o nome.
  const [slugTocado, setSlugTocado] = useState(false);
  const [skillMd, setSkillMd] = useState(TEMPLATE);
  const [file, setFile] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // O que um pacote com várias skills deixou na quarentena. Enquanto ele
  // existe, é ele que ocupa a tela: o formulário já fez o que tinha para fazer,
  // e repetir o seletor de arquivo com o pacote antigo dentro só confundiria.
  const [resultado, setResultado] = useState<QuarantineBundleResult | null>(null);

  // Na quarentena não há metadado separado do arquivo: nome, descrição, tags,
  // ícone e servidores não valem nada até o envio ser aprovado, e mostrá-los
  // prometeria algo que a tela não cumpre.
  const paraQuarentena = mode === 'zip' && destino === 'quarentena';

  function patchMeta(patch: Partial<SkillMetaValues>) {
    if (patch.slug !== undefined) setSlugTocado(true);
    const seguirNome = patch.name !== undefined && patch.slug === undefined && !slugTocado;
    setMeta((current) => ({
      ...current,
      ...patch,
      ...(seguirNome ? { slug: slugify(patch.name ?? '') } : {}),
    }));
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);

    try {
      if (paraQuarentena && file) {
        const envio = await importToQuarantine(file);
        // Dois corpos na mesma rota (`docs/15-quarentena.md`): uma skill só
        // continua indo direto para a ficha do envio, como sempre; um pacote
        // com várias fica nesta tela, porque há o que conferir.
        if ('bundle' in envio) {
          setResultado(envio);
          return;
        }
        toast.success(`Envio "${envio.name}" está na quarentena, esperando aprovação.`);
        navigate(`/quarentena/${envio.uuid}`);
        return;
      }

      const tags = parseTags(meta.tags);
      const icon = meta.icon.trim() || undefined;
      const detail =
        mode === 'zip' && file
          ? await importZip(file, { name: meta.name || undefined, description: meta.description, icon, tags, mcps: links })
          : await createSkill({
              name: meta.name,
              slug: meta.slug || undefined,
              description: meta.description,
              icon,
              // Nunca sai daqui com frontmatter: o formulário é a fonte da verdade.
              skillMd: stripFrontmatter(skillMd),
              tags,
              mcps: links,
            });

      toast.success(`Skill "${detail.name}" criada.`);
      navigate(`/skills/${detail.slug}`);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  if (resultado) {
    return (
      <BundleResult
        resultado={resultado}
        onNovoPacote={() => {
          setResultado(null);
          setFile(null);
        }}
      />
    );
  }

  return (
    <form onSubmit={submit} className="page">
      <div className="page-head">
        <div>
          <h1>{paraQuarentena ? 'Importar para a quarentena' : 'Nova skill'}</h1>
          <p className="sub">
            {paraQuarentena
              ? 'O pacote é guardado como está, sem virar skill; um pacote com várias skills vira um envio para cada uma. Nada entra no acervo antes de alguém aprovar.'
              : `Preencha o formulário ou importe um pacote (${FORMATOS_NA_TELA}) com um SKILL.md — um pacote com várias skills vai inteiro para a quarentena.`}
          </p>
        </div>
        <div className="segmented">
          {(['form', 'zip'] as const).map((option) => (
            <button key={option} type="button" className={mode === option ? 'active' : ''} onClick={() => setMode(option)}>
              {option === 'form' ? 'Formulário' : 'Importar pacote'}
            </button>
          ))}
        </div>
      </div>

      <Panel>
        {mode === 'zip' && (
          <>
            {/* O destino é escolha de quem importa, e só existe aqui: criar
                pelo formulário vai sempre direto para produção. */}
            <div className="destinos">
              <button
                type="button"
                className={`destino${destino === 'producao' ? ' active' : ''}`}
                onClick={() => setDestino('producao')}
                aria-pressed={destino === 'producao'}
              >
                <Sparkles />
                <span className="t">Direto para produção</span>
                <span className="h">
                  Vira skill na hora, com tags, ícone e os servidores escolhidos abaixo. Um pacote com várias skills
                  não entra por aqui: o caminho delas é a quarentena.
                </span>
              </button>
              <button
                type="button"
                className={`destino${destino === 'quarentena' ? ' active' : ''}`}
                onClick={() => setDestino('quarentena')}
                aria-pressed={destino === 'quarentena'}
              >
                <ShieldQuestion />
                <span className="t">Para a quarentena</span>
                <span className="h">Fica esperando aprovação. Não é publicado, não é indexado e não aparece no site.</span>
              </button>
            </div>
          </>
        )}

        {!paraQuarentena && (
          <>
            <SkillMetaForm values={meta} onChange={patchMeta} slugPlaceholder="gerado a partir do nome" slugRequired={false} nameRequired={mode === 'form'} />
            <PublishInPicker value={links} onChange={setLinks} />
          </>
        )}

        {mode === 'form' ? (
          <>
            <FrontmatterPreview values={meta} />
            <PromptEditor value={skillMd} onChange={setSkillMd} rows={22} />
          </>
        ) : (
          <label className="dropzone mt-5">
            <Upload />
            <span className="t">{file ? file.name : `Escolher um pacote: ${FORMATOS_NA_TELA}`}</span>
            <span className="h">
              {paraQuarentena
                ? 'A árvore de arquivos entra como está, o SKILL.md com o frontmatter dentro dele. Sem SKILL.md o pacote ainda entra — é na aprovação que ele é exigido.'
                : 'A árvore de arquivos é preservada; o SKILL.md é obrigatório. Os metadados do frontmatter dele preenchem os campos acima que ficarem em branco.'}
            </span>
            {/* Por que cada sufixo aparece por extenso: ver `ACCEPT_PACOTE`. */}
            <input
              type="file"
              accept={ACCEPT_PACOTE}
              className="hidden"
              onChange={(event) => setFile(event.target.files?.[0] ?? null)}
            />
          </label>
        )}
      </Panel>

      <div className="mt-4 flex justify-end gap-2">
        <Button variant="ghost" onClick={() => navigate(paraQuarentena ? '/quarentena' : '/skills')}>
          Cancelar
        </Button>
        <Button type="submit" disabled={submitting || (mode === 'zip' && !file)}>
          {submitting ? 'Enviando…' : paraQuarentena ? 'Enviar para a quarentena' : 'Criar skill'}
        </Button>
      </div>
    </form>
  );
}
