import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { createSkill, importZip } from '../api.js';
import { Button, Panel } from '../components/ui.js';
import { UploadIcon } from '../components/Icons.js';
import {
  FrontmatterPreview,
  SkillMetaForm,
  type SkillMetaValues,
} from '../components/SkillMetaForm.js';
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

export function NewSkillPage() {
  const navigate = useNavigate();
  const toast = useToast();

  const [mode, setMode] = useState<'form' | 'zip'>('form');
  const [meta, setMeta] = useState<SkillMetaValues>({
    name: '',
    slug: '',
    description: '',
    tags: '',
    // Nasce privada, como o default do schema, do MCP admin e da documentação.
    isPublic: false,
  });
  // Enquanto o slug não for editado à mão, ele acompanha o nome.
  const [slugTocado, setSlugTocado] = useState(false);
  const [skillMd, setSkillMd] = useState(TEMPLATE);
  const [file, setFile] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);

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
      const tags = parseTags(meta.tags);
      const detail =
        mode === 'zip' && file
          ? await importZip(file, {
              name: meta.name || undefined,
              description: meta.description,
              tags,
              isPublic: meta.isPublic,
            })
          : await createSkill({
              name: meta.name,
              slug: meta.slug || undefined,
              description: meta.description,
              // Nunca sai daqui com frontmatter: o formulário é a fonte da verdade.
              skillMd: stripFrontmatter(skillMd),
              tags,
              isPublic: meta.isPublic,
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
    <form onSubmit={submit} className="mx-auto max-w-5xl">
      <div className="page-head">
        <div>
          <h1 className="display">Nova skill</h1>
          <p className="sub">
            Preencha o formulário ou importe um pacote .zip contendo um SKILL.md.
          </p>
        </div>
      </div>

      <div className="segmented mb-4">
        {(['form', 'zip'] as const).map((option) => (
          <button
            key={option}
            type="button"
            className={mode === option ? 'active' : ''}
            onClick={() => setMode(option)}
          >
            {option === 'form' ? 'Formulário' : 'Importar .zip'}
          </button>
        ))}
      </div>

      <Panel>
        <SkillMetaForm
          values={meta}
          onChange={patchMeta}
          slugPlaceholder="gerado a partir do nome"
          slugRequired={false}
          nameRequired={mode === 'form'}
          publicLabel="Publicar no site agora (dá para publicar depois, aqui mesmo)"
        />

        {mode === 'form' ? (
          <>
            <FrontmatterPreview values={meta} />
            <PromptEditor value={skillMd} onChange={setSkillMd} rows={22} />
          </>
        ) : (
          <label className="dropzone mt-5">
            <UploadIcon />
            <span className="t">{file ? file.name : 'Escolher um arquivo .zip'}</span>
            <span className="h">
              A árvore de arquivos é preservada; o SKILL.md é obrigatório. Os metadados do
              frontmatter dele preenchem os campos acima que ficarem em branco.
            </span>
            <input
              type="file"
              accept=".zip,application/zip"
              className="hidden"
              onChange={(event) => setFile(event.target.files?.[0] ?? null)}
            />
          </label>
        )}
      </Panel>

      <div className="mt-5 flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={() => navigate('/skills')}>
          Cancelar
        </Button>
        <Button type="submit" disabled={submitting || (mode === 'zip' && !file)}>
          {submitting ? 'Criando…' : 'Criar skill'}
        </Button>
      </div>
    </form>
  );
}
