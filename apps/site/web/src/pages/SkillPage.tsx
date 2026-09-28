import { useEffect, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import {
  downloadUrl,
  skillPackageUrl,
  fetchSkill,
  formatCount,
  formatDate,
  profilePath,
  type SkillDetail,
} from '../api.js';
import { SkillDoc, type DocView } from '../components/SkillDoc.js';
import { CopyButton } from '../components/CopyButton.js';
import { FileTree } from '../components/FileTree.js';
import {
  ArrowLeftIcon,
  DownloadIcon,
  EyeIcon,
  FileIcon,
  GlobeIcon,
  PlugIcon,
  TagIcon,
  UserIcon,
} from '../components/Icons.js';
import { useMeta } from '../useMeta.js';
import { fraseViaMcp, viaMcp } from '../viaMcp.js';

/** O SKILL.md da raiz; um `skill.md` dentro de uma pasta é só mais um arquivo. */
const isRootSkillMd = (path: string) => path.toLowerCase() === 'skill.md';

export function SkillPage() {
  const { slug = '' } = useParams();
  // O arquivo aberto na caixa do prompt mora no endereço (`?file=`), para o
  // link levar direto a ele e o "voltar" do navegador fechar o que se abriu.
  const [params, setParams] = useSearchParams();
  const docRef = useRef<HTMLElement>(null);
  const meta = useMeta();
  const [skill, setSkill] = useState<SkillDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setSkill(null);
    setError(null);
    window.scrollTo({ top: 0 });

    fetchSkill(slug)
      .then((data) => active && setSkill(data))
      .catch((err: Error) => active && setError(err.message));

    return () => {
      active = false;
    };
  }, [slug]);

  useEffect(() => {
    const name = meta?.name ?? 'Purple Skills';
    document.title = skill ? `${skill.name} — ${name}` : name;
  }, [skill, meta]);

  if (error) {
    return (
      <section className="skill-page">
        <div className="wrap">
          <div className="empty" style={{ maxWidth: '30rem', margin: '40px auto' }}>
            <img className="wiz" src="/assets/images/icon-purple-right-279x400.png" alt="" />
            <h3>Skill não encontrada</h3>
            <p>
              {error === 'Skill não encontrada'
                ? 'Ela pode não existir, ser privada ou estar desligada — só as públicas aparecem aqui.'
                : error}
            </p>
            <Link to="/#skills" className="btn btn-primary" style={{ marginTop: '18px' }}>
              <ArrowLeftIcon /> Voltar às skills
            </Link>
          </div>
        </div>
      </section>
    );
  }

  if (!skill) {
    return (
      <section className="skill-page">
        <div className="wrap" style={{ display: 'grid', gap: '16px' }}>
          <div className="skel" style={{ height: '2.6rem', maxWidth: '28rem' }} />
          <div className="skel" style={{ height: '1.2rem', maxWidth: '40rem' }} />
          <div className="skel" style={{ height: '22rem' }} />
        </div>
      </section>
    );
  }

  const publicUrl = `${meta?.baseUrl ?? window.location.origin}/skills/${skill.slug}`;
  // `mcpUrl` é `<base>/mcp`; os virtuais ficam em `<base>/virtual/<slug>/mcp`.
  const mcpBase = meta?.mcpUrl ? meta.mcpUrl.replace(/\/mcp$/, '') : null;
  // O exemplo `get_skill("<slug>")` só aparece quando algum servidor listado a
  // publica pela porta `skill` — sem ela a ferramenta responde "Skill não
  // encontrada", e sem servidor nenhum a página oferece só o download.
  const via = viaMcp(skill.mcps);

  const skillMdPath = skill.files.find((file) => isRootSkillMd(file.relativePath))?.relativePath ?? 'SKILL.md';
  const asked = params.get('file');
  const askedFile = asked === null ? undefined : skill.files.find((file) => file.relativePath === asked);
  // Um `?file=` que não está na skill (link velho, arquivo removido) cai na leitura.
  const view: DocView =
    asked === null
      ? { kind: 'render' }
      : isRootSkillMd(asked)
        ? { kind: 'source' }
        : askedFile
          ? { kind: 'file', file: askedFile }
          : { kind: 'render' };
  const selected = view.kind === 'file' ? view.file.relativePath : view.kind === 'source' ? skillMdPath : null;

  /** Troca o que a caixa mostra. Abrir pela árvore empilha no histórico; trocar de guia, não. */
  function show(next: DocView, replace: boolean) {
    setParams(
      (current) => {
        const updated = new URLSearchParams(current);
        if (next.kind === 'render') updated.delete('file');
        else updated.set('file', next.kind === 'source' ? skillMdPath : next.file.relativePath);
        return updated;
      },
      { replace },
    );
  }

  function openFromTree(path: string) {
    const file = skill!.files.find((item) => item.relativePath === path);
    if (!file) return;
    show(isRootSkillMd(path) ? { kind: 'source' } : { kind: 'file', file }, path === selected);
    // No celular a árvore fica abaixo da caixa; no desktop a página pode ter
    // rolado para longe do topo dela. Nos dois casos, a caixa volta à vista.
    const box = docRef.current;
    if (box) {
      const top = box.getBoundingClientRect().top;
      if (top < 0 || top > window.innerHeight * 0.6) box.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  return (
    <section className="skill-page">
      <div className="wrap">
        <Link to="/#skills" className="back-link">
          <ArrowLeftIcon /> Skills
        </Link>

        <header className="skill-head">
          <span
            className="public-pill"
            title="Está aqui por ter sido marcada como pública, ou por estar em um catálogo público ou em um servidor MCP aberto."
          >
            <GlobeIcon /> Skill pública
          </span>
          <h1 className="display">{skill.name}</h1>
          {skill.description && <p className="lead">{skill.description}</p>}

          {skill.tags.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-2">
              {skill.tags.map((tag) => (
                <Link key={tag} to={`/?tag=${encodeURIComponent(tag)}#skills`} className="tag">
                  <TagIcon className="h-3 w-3" />
                  {tag}
                </Link>
              ))}
            </div>
          )}

          <div className="skill-meta">
            {/*
              A autoria, pelo username (`docs/19-username.md` decisão 11). Sem
              dono — skill órfã, criada pela sessão de bootstrap ou pelo token
              global — a página simplesmente não credita ninguém, em vez de
              dizer "sem dono": quem lê o site não tem o que fazer com isso.
            */}
            {skill.ownerUsername && (
              <span>
                <UserIcon />{' '}
                {/* Vira link só quando o dono publicou o perfil
                    (`docs/20-perfil.md` §7): sem a conferência, o site
                    apontaria para 404 em toda conta que nunca abriu a tela. */}
                {skill.ownerHasProfile ? (
                  <Link to={profilePath(skill.ownerUsername)}>por @{skill.ownerUsername}</Link>
                ) : (
                  <>por @{skill.ownerUsername}</>
                )}
              </span>
            )}
            <span>
              <EyeIcon /> {formatCount(skill.viewCount)} acessos
            </span>
            <span>
              <DownloadIcon /> {formatCount(skill.downloadCount)} downloads
            </span>
            <span>
              <FileIcon /> {skill.fileCount} arquivo{skill.fileCount === 1 ? '' : 's'}
            </span>
            <span>atualizada em {formatDate(skill.updatedAt)}</span>
          </div>

          <div className="mt-4 flex flex-wrap gap-3">
            <a href={downloadUrl(skill.slug)} className="btn btn-primary">
              <DownloadIcon /> Baixar pacote .zip
            </a>
            <a href={skillPackageUrl(skill.slug)} className="btn btn-ghost">
              <DownloadIcon /> Baixar pacote .skill
            </a>
            <CopyButton value={publicUrl} />
          </div>
        </header>

        <div className="skill-body">
          <article className="min-w-0 skill-doc" ref={docRef}>
            <SkillDoc
              key={skill.slug}
              slug={skill.slug}
              name={skill.name}
              description={skill.description}
              tags={skill.tags}
              skillMd={skill.skillMd}
              skillMdPath={skillMdPath}
              view={view}
              onView={(next) => show(next, true)}
            />
          </article>

          <aside className="skill-aside">
            <section className="aside-card">
              <h2>
                <FileIcon /> Arquivos
              </h2>
              <FileTree slug={skill.slug} files={skill.files} selected={selected} onOpen={openFromTree} />
              <p className="ft-hint">
                Clique num arquivo para lê-lo. É esta a pasta que aparece ao descompactar o .zip.
              </p>
            </section>

            {/* Onde a skill está: os servidores abertos que a publicam, e por
                quais portas em cada um. O padrão responde também em /mcp. */}
            <section className="aside-card">
              <h2>
                <PlugIcon /> Via MCP
              </h2>
              <p className="mt-2 text-xs" style={{ color: 'var(--text-faint)' }}>
                {fraseViaMcp(via, skill.mcps.length, skill.slug)}
              </p>
              {via.caso === 'ferramenta' && (
                <div className="code-card" style={{ marginTop: '10px' }}>
                  <div className="code-body" style={{ padding: '12px 14px', fontSize: '.76rem' }}>
                    <span className="k">get_skill</span>
                    {'('}
                    <span className="s">"{skill.slug}"</span>
                    {')'}
                  </div>
                </div>
              )}
              <ul className="mt-3 grid gap-2 text-xs">
                {skill.mcps.map((mcp) => {
                  const url = mcpBase
                    ? mcp.isDefault
                      ? `${mcpBase}/mcp`
                      : `${mcpBase}/virtual/${mcp.slug}/mcp`
                    : null;
                  const portas = [mcp.asSkill && 'skill', mcp.asPrompt && 'prompt', mcp.asResource && 'resource']
                    .filter(Boolean)
                    .join(' · ');
                  return (
                    <li key={mcp.uuid} className="flex flex-wrap items-center justify-between gap-2">
                      <span>
                        <strong>{mcp.name}</strong>
                        {mcp.isDefault && ' (padrão)'}
                        <span style={{ color: 'var(--text-faint)' }}> — {portas || 'sem porta'}</span>
                      </span>
                      {url && <CopyButton value={url} label="Copiar URL" className="btn btn-ghost btn-sm" />}
                    </li>
                  );
                })}
              </ul>
            </section>
          </aside>
        </div>
      </div>
    </section>
  );
}
