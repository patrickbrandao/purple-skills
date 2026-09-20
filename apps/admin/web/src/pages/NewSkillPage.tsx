import { useState, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ShieldQuestion, Sparkles, Upload } from 'lucide-react';
import { createSkill, importToQuarantine, importZip, type SkillLinkInput } from '../api.js';
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

  return (
    <form onSubmit={submit} className="page">
      <div className="page-head">
        <div>
          <h1>{paraQuarentena ? 'Importar para a quarentena' : 'Nova skill'}</h1>
          <p className="sub">
            {paraQuarentena
              ? 'O pacote é guardado como está, sem virar skill. Ele só entra no acervo quando alguém o aprovar.'
              : 'Preencha o formulário ou importe um pacote .zip/.skill contendo um SKILL.md.'}
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
                <span className="h">Vira skill na hora, com tags, ícone e os servidores escolhidos abaixo.</span>
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
            <span className="t">{file ? file.name : 'Escolher um arquivo .zip ou .skill'}</span>
            <span className="h">
              {paraQuarentena
                ? 'A árvore de arquivos entra como está, o SKILL.md com o frontmatter dentro dele. Sem SKILL.md o pacote ainda entra — é na aprovação que ele é exigido.'
                : 'A árvore de arquivos é preservada; o SKILL.md é obrigatório. Os metadados do frontmatter dele preenchem os campos acima que ficarem em branco.'}
            </span>
            <input
              type="file"
              accept=".zip,.skill,application/zip"
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
