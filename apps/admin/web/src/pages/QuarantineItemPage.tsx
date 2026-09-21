import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Binary, Download, ExternalLink, FilePlus, Save, ShieldCheck, Trash2 } from 'lucide-react';
import {
  createQuarantineFile,
  deleteQuarantineFile,
  deleteQuarantineItem,
  formatBytes,
  formatRelative,
  getQuarantineFile,
  getQuarantineItem,
  promoteQuarantineItem,
  quarantineDownloadUrl,
  rawQuarantineFileUrl,
  setQuarantineFile,
  type QuarantineSheet,
  type SkillFileMeta,
} from '../api.js';
import { Button, EmptyState, Panel, Skel, useConfirm } from '../components/ui.js';
import { CodeEditor } from '../components/CodeEditor.js';
import { FileTypeIcon } from '../components/FileTypeIcon.js';
import { useToast } from '../components/Toast.js';

/** O arquivo principal, comparado como o servidor o compara: sem caixa. */
const isSkillMdPath = (path: string): boolean => path.toLowerCase() === 'skill.md';

/** O SKILL.md abre primeiro; o resto vem em ordem de caminho. */
function ordenar(files: readonly SkillFileMeta[]): SkillFileMeta[] {
  const principal = (file: SkillFileMeta) => (isSkillMdPath(file.relativePath) ? 0 : 1);
  return [...files].sort(
    (a, b) => principal(a) - principal(b) || a.relativePath.localeCompare(b.relativePath),
  );
}

/**
 * Um envio da quarentena (`docs/15-quarentena.md`): a lista de arquivos e o
 * editor cru.
 *
 * "Cru" é a regra da tela, não um detalhe: aqui **não** existe formulário de
 * metadados, o SKILL.md aparece com o frontmatter dentro dele e é isso que é
 * gravado. Na skill de produção os metadados moram em colunas e o frontmatter é
 * remontado na leitura; enquanto o envio não for aprovado, o arquivo é a única
 * verdade que existe.
 */
export function QuarantineItemPage() {
  const { uuid = '' } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const confirm = useConfirm();

  const [item, setItem] = useState<QuarantineSheet | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [aberto, setAberto] = useState<string | null>(null);
  const [conteudo, setConteudo] = useState<{ path: string; text: string | null; meta: SkillFileMeta } | null>(null);
  const [rascunho, setRascunho] = useState('');
  const [salvando, setSalvando] = useState(false);
  const [ocupado, setOcupado] = useState(false);
  /** O caminho sendo digitado no "Novo arquivo"; `null` quando a linha está fechada. */
  const [criando, setCriando] = useState<string | null>(null);

  const files = useMemo(() => ordenar(item?.files ?? []), [item]);

  useEffect(() => {
    let active = true;
    getQuarantineItem(uuid)
      .then((data) => {
        if (!active) return;
        setItem(data);
        setAberto((current) => current ?? ordenar(data.files)[0]?.relativePath ?? null);
      })
      .catch((err) => {
        if (active) setErro((err as Error).message);
      });
    return () => {
      active = false;
    };
  }, [uuid]);

  // Um arquivo por vez: o painel busca o conteúdo ao abrir, e a resposta
  // atrasada de um arquivo trocado no meio do caminho é descartada.
  useEffect(() => {
    if (!aberto) {
      setConteudo(null);
      return;
    }
    let active = true;
    setConteudo(null);
    getQuarantineFile(uuid, aberto)
      .then((file) => {
        if (!active) return;
        const meta: SkillFileMeta = {
          relativePath: file.relativePath,
          mimeType: file.mimeType,
          sizeBytes: file.sizeBytes,
          isText: file.isText,
        };
        setConteudo({ path: aberto, text: file.content, meta });
        setRascunho(file.content ?? '');
      })
      .catch((err) => {
        if (active) toast.error((err as Error).message);
      });
    return () => {
      active = false;
    };
  }, [uuid, aberto, toast]);

  const sujo = conteudo?.text !== null && conteudo !== null && rascunho !== conteudo.text;

  /*
   * Rascunho pendente segura o fechar e o recarregar da aba, como na edição de
   * uma skill: aqui não há salvamento automático, e o editor é a única cópia
   * do que foi digitado.
   */
  useEffect(() => {
    if (!sujo) return;
    const avisar = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', avisar);
    return () => window.removeEventListener('beforeunload', avisar);
  }, [sujo]);

  /** Trocar de arquivo com rascunho pendente pergunta antes de descartá-lo. */
  async function abrir(path: string) {
    if (path === aberto) return;
    if (sujo) {
      const ok = await confirm({
        title: `Descartar as alterações em "${conteudo?.path}"?`,
        description: 'O que você digitou e não salvou se perde.',
        confirmLabel: 'Descartar',
        danger: true,
      });
      if (!ok) return;
    }
    setAberto(path);
  }

  /**
   * Relê a ficha depois de criar ou remover um arquivo: `fileCount` e
   * `sizeBytes` são do envio inteiro e não dá para deduzi-los aqui.
   */
  const recarregar = useCallback(async () => {
    try {
      setItem(await getQuarantineItem(uuid));
    } catch (err) {
      toast.error((err as Error).message);
    }
  }, [toast, uuid]);

  async function criar() {
    const path = (criando ?? '').trim();
    if (!path) {
      setCriando(null);
      return;
    }
    try {
      const meta = await createQuarantineFile(uuid, path);
      setCriando(null);
      await recarregar();
      setAberto(meta.relativePath);
      toast.success(`"${meta.relativePath}" criado.`);
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  async function remover(path: string) {
    const ok = await confirm({
      title: `Remover "${path}" do envio?`,
      description: 'Só este arquivo sai; o envio continua na quarentena.',
      confirmLabel: 'Remover',
      danger: true,
    });
    if (!ok) return;
    try {
      await deleteQuarantineFile(uuid, path);
      if (aberto === path) setAberto(null);
      await recarregar();
      toast.success(`"${path}" removido.`);
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  const salvar = useCallback(async () => {
    if (!conteudo || conteudo.text === null) return;
    setSalvando(true);
    try {
      const meta = await setQuarantineFile(uuid, conteudo.path, rascunho);
      setConteudo((current) => (current ? { ...current, text: rascunho, meta } : current));
      setItem((current) =>
        current
          ? {
              ...current,
              files: current.files.map((file) => (file.relativePath === meta.relativePath ? meta : file)),
            }
          : current,
      );
      toast.success(`"${conteudo.path}" salvo.`);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setSalvando(false);
    }
  }, [conteudo, rascunho, toast, uuid]);

  async function aprovar() {
    if (!item) return;
    const ok = await confirm({
      title: `Aprovar o envio "${item.name}"?`,
      description:
        'A skill é criada no acervo com estes arquivos e com você como dono, ainda sem servidor nem ' +
        'catálogo, e o envio sai da quarentena. O nome, a descrição e as tags saem do SKILL.md.',
      confirmLabel: 'Aprovar e criar a skill',
    });
    if (!ok) return;
    setOcupado(true);
    try {
      const skill = await promoteQuarantineItem(item.uuid);
      toast.success(`Skill "${skill.name}" criada a partir do envio.`);
      navigate(`/skills/${skill.slug}`);
    } catch (err) {
      toast.error((err as Error).message);
      setOcupado(false);
    }
  }

  async function descartar() {
    if (!item) return;
    const ok = await confirm({
      title: `Descartar o envio "${item.name}"?`,
      description: 'Os arquivos dele somem. Nada foi publicado ainda, então nada mais é afetado.',
      confirmLabel: 'Descartar',
      danger: true,
    });
    if (!ok) return;
    setOcupado(true);
    try {
      await deleteQuarantineItem(item.uuid);
      toast.success(`Envio "${item.name}" descartado.`);
      navigate('/quarantine');
    } catch (err) {
      toast.error((err as Error).message);
      setOcupado(false);
    }
  }

  if (erro) {
    return (
      <div className="page">
        <EmptyState
          icon={<Binary />}
          title="Envio não encontrado"
          description={erro}
          action={
            <Link to="/quarantine" className="btn btn-ghost">
              Voltar à quarentena
            </Link>
          }
        />
      </div>
    );
  }

  if (!item) {
    return (
      <div className="page">
        <Skel h={240} />
      </div>
    );
  }

  const skillMd = files.find((file) => isSkillMdPath(file.relativePath));
  // Um SKILL.md binário conta como presente e **não** dá para aprovar: a
  // promoção o decodifica para tirar nome, descrição e tags. O envio aceitou o
  // arquivo de propósito (é o pacote torto que a quarentena existe para
  // receber); o conserto é aqui, antes de aprovar.
  const podeAprovar = skillMd !== undefined && skillMd.isText;

  return (
    <div className="page">
      <div className="page-head">
        <div className="min-w-0">
          <h1 className="truncate">{item.name}</h1>
          <p className="sub">
            {item.description || 'Sem descrição no SKILL.md.'}
            <br />
            <span className="mono">{item.sourceFilename ?? 'pacote sem nome'}</span> · enviado por{' '}
            {item.ownerEmail ?? 'sem dono'} · {formatRelative(item.createdAt)} · {item.fileCount} arquivo
            {item.fileCount === 1 ? '' : 's'} · {formatBytes(item.sizeBytes)}
          </p>
        </div>
        <div className="page-actions">
          <a href={quarantineDownloadUrl(item.uuid)} className="btn btn-quiet" download title="Baixar o pacote como está">
            <Download /> Baixar
          </a>
          <Button variant="danger" onClick={() => void descartar()} disabled={ocupado}>
            <Trash2 /> Descartar
          </Button>
          {item.canPromote && (
            <Button onClick={() => void aprovar()} disabled={ocupado || !podeAprovar}>
              <ShieldCheck /> Aprovar
            </Button>
          )}
        </div>
      </div>

      {skillMd === undefined && (
        <Panel>
          <p className="panel-hint mb-0">
            Este envio não tem <span className="mono">SKILL.md</span>, e sem ele não há o que aprovar — é o arquivo que
            diz o nome, a descrição e as tags da skill. Crie-o abaixo, ou descarte o envio.
          </p>
        </Panel>
      )}

      {skillMd !== undefined && !skillMd.isText && (
        <Panel>
          <p className="panel-hint mb-0">
            O <span className="mono">SKILL.md</span> deste envio não é um texto UTF-8 — veio em outra codificação,
            como a de um editor Windows. Ele entrou assim de propósito, mas a aprovação precisa lê-lo para tirar o
            nome, a descrição e as tags. Remova-o e crie um <span className="mono">SKILL.md</span> novo aqui mesmo,
            colando o conteúdo já convertido.
          </p>
        </Panel>
      )}

      {!item.canPromote && (
        <Panel>
          <p className="panel-hint mb-0">
            Você pode revisar e corrigir os arquivos deste envio, mas quem o aprova, nesta instalação, é outra pessoa.
          </p>
        </Panel>
      )}

      {/* `file-tree` traz as cores por tipo de arquivo (as mesmas da edição de
          skill); `no-resizer`, a divisória que não arrasta — o nome evita os
          utilitários do Tailwind, que valem neste bundle. */}
      <div className="files-ws file-tree no-resizer mt-4">
        <div className="files-tree">
          <div className="fx-head">
            <h2 className="fx-title">
              Arquivos <span className="fx-count">{files.length}</span>
            </h2>
            <span className="fx-tools">
              <button
                type="button"
                className="row-action"
                title="Novo arquivo no envio"
                aria-label="Novo arquivo no envio"
                onClick={() => setCriando(criando === null ? '' : null)}
              >
                <FilePlus />
              </button>
            </span>
          </div>

          <div className="fx-body">
            <ul className="ft-list ft-root">
              {criando !== null && (
                <li>
                  <div className="fx-new">
                    <FileTypeIcon fileName={criando.trim() || 'novo'} />
                    <input
                      className="fx-input"
                      value={criando}
                      autoFocus
                      placeholder="SKILL.md"
                      onChange={(event) => setCriando(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          event.preventDefault();
                          void criar();
                        } else if (event.key === 'Escape') {
                          event.preventDefault();
                          event.stopPropagation();
                          setCriando(null);
                        }
                      }}
                      aria-label="Caminho do novo arquivo do envio"
                      spellCheck={false}
                      autoCapitalize="off"
                      autoComplete="off"
                    />
                  </div>
                  <p className="fx-msg">
                    Enter cria o arquivo vazio · Esc desiste · a/b.md cria a pasta junto · só texto
                  </p>
                </li>
              )}
              {files.map((file) => (
                <li key={file.relativePath}>
                  <div className={`ft-line fx-line${file.relativePath === aberto ? ' focus' : ''}`}>
                    <button
                      type="button"
                      className="ft-row"
                      // O nome acessível do botão: o ícone é decorativo e o
                      // tamanho, sozinho, não diz de que arquivo se trata.
                      title={`${file.relativePath} — ${formatBytes(file.sizeBytes)}`}
                      onClick={() => void abrir(file.relativePath)}
                    >
                      <FileTypeIcon fileName={file.relativePath} />
                      <span className="ft-name mono">{file.relativePath}</span>
                      <span className="ft-size">{formatBytes(file.sizeBytes)}</span>
                    </button>
                    <span className="fx-actions">
                      <button
                        type="button"
                        className="row-action danger"
                        title={`Remover ${file.relativePath}`}
                        aria-label={`Remover ${file.relativePath}`}
                        onClick={() => void remover(file.relativePath)}
                      >
                        <Trash2 />
                      </button>
                    </span>
                  </div>
                </li>
              ))}
            </ul>
            {files.length === 0 && criando === null && <p className="fx-hint">O envio está vazio.</p>}
          </div>

          <div className="fx-foot">
            <span className="fx-hint">Os arquivos entram e saem só por aqui.</span>
          </div>
        </div>

        <div className="files-resizer" aria-hidden="true" />

        <div className="files-editor">
          {conteudo === null && aberto !== null && <Skel h={320} />}
          {aberto === null && (
            <EmptyState icon={<Binary />} title="Nenhum arquivo aberto" description="Escolha um arquivo à esquerda." />
          )}
          {conteudo !== null && conteudo.text === null && (
            <EmptyState
              icon={<Binary />}
              title={isSkillMdPath(conteudo.path) ? 'SKILL.md fora de UTF-8' : 'Arquivo binário'}
              description={
                isSkillMdPath(conteudo.path)
                  ? 'Não abre no editor de texto: veio em outra codificação. Baixe-o, converta para UTF-8, remova-o daqui e crie um SKILL.md novo com o conteúdo convertido — tudo sem sair da quarentena.'
                  : 'Não abre no editor de texto. Ele veio dentro do pacote; aqui só se cria arquivo de texto. Para trocá-lo, remova-o e importe o pacote de novo.'
              }
              action={
                <a href={rawQuarantineFileUrl(uuid, conteudo.path)} className="btn btn-quiet btn-sm" download>
                  <Download /> Baixar o arquivo
                </a>
              }
            />
          )}
          {conteudo !== null && conteudo.text !== null && (
            <>
              <div className="fe-head">
                <span className="mono truncate">{conteudo.path}</span>
                <span className="flex items-center gap-1">
                  <a
                    href={rawQuarantineFileUrl(uuid, conteudo.path)}
                    className="btn btn-quiet btn-sm"
                    target="_blank"
                    rel="noreferrer"
                    title="Abrir cru numa aba"
                  >
                    <ExternalLink /> Cru
                  </a>
                  <Button size="sm" onClick={() => void salvar()} disabled={!sujo || salvando}>
                    <Save /> {salvando ? 'Salvando…' : 'Salvar'}
                  </Button>
                </span>
              </div>
              <CodeEditor
                value={rascunho}
                onChange={setRascunho}
                label={`Conteúdo de ${conteudo.path}`}
                className="fe-body"
              />
              <div className="fe-foot">
                <span>{conteudo.meta.mimeType}</span>
                <span>
                  O arquivo é gravado como está — o frontmatter do SKILL.md faz parte dele até o envio ser aprovado.
                </span>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
