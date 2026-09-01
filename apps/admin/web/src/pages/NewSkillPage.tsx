import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { createSkill, importZip } from '../api.js';
import { Button, Card, inputClass, labelClass } from '../components/ui.js';
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
  const [isPublic, setIsPublic] = useState(true);
  const [skillMd, setSkillMd] = useState(TEMPLATE);
  const [file, setFile] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const tagList = tags.split(',').map((tag) => tag.trim()).filter(Boolean);

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
      <h1 className="text-2xl font-semibold text-purple-50">Nova skill</h1>
      <p className="mt-1 text-sm text-slate-500">
        Preencha o formulário ou importe um pacote .zip contendo um SKILL.md.
      </p>

      <div className="mt-5 inline-flex rounded-lg border border-purple-400/12 bg-ink-850 p-0.5">
        {(['form', 'zip'] as const).map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => setMode(option)}
            className={`rounded-md px-3.5 py-1.5 text-xs font-medium transition ${
              mode === option ? 'bg-purple-600 text-white' : 'text-slate-400 hover:text-purple-200'
            }`}
          >
            {option === 'form' ? 'Formulário' : 'Importar .zip'}
          </button>
        ))}
      </div>

      <Card className="mt-4 space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block">
            <span className={labelClass}>Nome {mode === 'zip' && '(opcional)'}</span>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              required={mode === 'form'}
              placeholder="Conventional Commits"
              className={`${inputClass} mt-1.5`}
            />
          </label>

          {mode === 'form' && (
            <label className="block">
              <span className={labelClass}>Slug (opcional)</span>
              <input
                value={slug}
                onChange={(event) => setSlug(event.target.value)}
                placeholder="gerado a partir do nome"
                className={`${inputClass} mt-1.5`}
              />
            </label>
          )}
        </div>

        <label className="block">
          <span className={labelClass}>Descrição</span>
          <textarea
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            rows={2}
            placeholder="O que esta skill faz, em uma frase."
            className={`${inputClass} mt-1.5 resize-y`}
          />
        </label>

        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block">
            <span className={labelClass}>Tags (separadas por vírgula)</span>
            <input
              value={tags}
              onChange={(event) => setTags(event.target.value)}
              placeholder="git, workflow, produtividade"
              className={`${inputClass} mt-1.5`}
            />
          </label>

          <label className="flex cursor-pointer items-center gap-3 self-end rounded-lg border border-purple-400/15 bg-ink-850 px-3.5 py-2.5">
            <input
              type="checkbox"
              checked={isPublic}
              onChange={(event) => setIsPublic(event.target.checked)}
              className="h-4 w-4 accent-purple-500"
            />
            <span className="text-sm text-purple-100">Publicar no site imediatamente</span>
          </label>
        </div>

        {mode === 'form' ? (
          <label className="block">
            <span className={labelClass}>Conteúdo do SKILL.md</span>
            <textarea
              value={skillMd}
              onChange={(event) => setSkillMd(event.target.value)}
              rows={20}
              required
              spellCheck={false}
              className={`${inputClass} mt-1.5 resize-y font-mono text-[13px] leading-relaxed`}
            />
          </label>
        ) : (
          <label className="flex cursor-pointer flex-col items-center gap-2 rounded-xl border border-dashed border-purple-400/25 bg-ink-900/50 px-4 py-10 text-center transition hover:border-purple-400/50 hover:bg-ink-850">
            <UploadIcon className="h-7 w-7 text-purple-400" />
            <span className="text-sm text-purple-100">
              {file ? file.name : 'Escolher um arquivo .zip'}
            </span>
            <span className="text-xs text-slate-600">
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
      </Card>

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
