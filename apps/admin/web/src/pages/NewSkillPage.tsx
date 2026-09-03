import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { createSkill, importZip } from '../api.js';
import { Button, Field, Panel } from '../components/ui.js';
import { UploadIcon } from '../components/Icons.js';
import { useToast } from '../components/Toast.js';

const TEMPLATE = `---
name: Minha Skill
description: O que esta skill faz, em uma frase.
---

# Minha Skill

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
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [description, setDescription] = useState('');
  const [tags, setTags] = useState('');
  // Nasce privada, como o default do schema, do MCP admin e da documentação.
  const [isPublic, setIsPublic] = useState(false);
  const [skillMd, setSkillMd] = useState(TEMPLATE);
  const [file, setFile] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const tagList = tags
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);

    try {
      const detail =
        mode === 'zip' && file
          ? await importZip(file, { name: name || undefined, description, tags: tagList, isPublic })
          : await createSkill({
              name,
              slug: slug || undefined,
              description,
              skillMd,
              tags: tagList,
              isPublic,
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
    <form onSubmit={submit} className="mx-auto max-w-3xl">
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

      <Panel className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={mode === 'zip' ? 'Nome (opcional)' : 'Nome'}>
            <input
              className="field"
              value={name}
              onChange={(event) => setName(event.target.value)}
              required={mode === 'form'}
              placeholder="Conventional Commits"
            />
          </Field>

          {mode === 'form' && (
            <Field label="Slug (opcional)">
              <input
                className="field"
                value={slug}
                onChange={(event) => setSlug(event.target.value)}
                placeholder="gerado a partir do nome"
              />
            </Field>
          )}
        </div>

        <Field label="Descrição">
          <textarea
            className="field resize-y"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            rows={2}
            placeholder="O que esta skill faz, em uma frase."
          />
        </Field>

        <div className="grid items-end gap-4 sm:grid-cols-2">
          <Field label="Tags (separadas por vírgula)">
            <input
              className="field"
              value={tags}
              onChange={(event) => setTags(event.target.value)}
              placeholder="git, workflow, produtividade"
            />
          </Field>

          <label
            className="flex cursor-pointer items-center gap-3 rounded-xl px-3.5 py-3"
            style={{ border: '1px solid var(--border-strong)', background: 'var(--surface-2)' }}
          >
            <input
              type="checkbox"
              checked={isPublic}
              onChange={(event) => setIsPublic(event.target.checked)}
              className="h-4 w-4"
            />
            <span className="text-sm">
              Publicar no site agora (dá para publicar depois em Metadados)
            </span>
          </label>
        </div>

        {mode === 'form' ? (
          <Field label="Conteúdo do SKILL.md">
            <textarea
              className="field field-mono resize-y"
              value={skillMd}
              onChange={(event) => setSkillMd(event.target.value)}
              rows={20}
              required
              spellCheck={false}
            />
          </Field>
        ) : (
          <label className="dropzone">
            <UploadIcon />
            <span className="t">{file ? file.name : 'Escolher um arquivo .zip'}</span>
            <span className="h">
              A árvore de arquivos é preservada; o SKILL.md é obrigatório.
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
