import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { criarCacheDeDigesto, medirSkillMd } from './digest.js';

describe('medirSkillMd', () => {
  it('devolve o sha256 do texto no formato que a SEP pede, e o tamanho em bytes', () => {
    const texto = '---\nname: x\n---\n\n# Título\n';

    expect(medirSkillMd(texto)).toEqual({
      digest: `sha256:${createHash('sha256').update(texto, 'utf8').digest('hex')}`,
      size: Buffer.byteLength(texto, 'utf8'),
    });
  });

  // O `size` da SEP é o do conteúdo cru, e o host compara antes do hash: contar
  // caractere faria toda skill acentuada falhar a verificação por tamanho.
  it('conta byte, não caractere', () => {
    expect(medirSkillMd('ação').size).toBe(6);
  });
});

describe('o cache do digest', () => {
  const medida = { digest: `sha256:${'a'.repeat(64)}`, size: 10 };

  it('devolve o que guardou, pela chave (uuid, updatedAt)', () => {
    const cache = criarCacheDeDigesto();

    expect(cache.ler('uuid-1', '2026-01-02T00:00:00.000Z')).toBeUndefined();
    cache.guardar('uuid-1', '2026-01-02T00:00:00.000Z', medida);

    expect(cache.ler('uuid-1', '2026-01-02T00:00:00.000Z')).toEqual(medida);
    // Outra versão da mesma skill é outra entrada: é assim que uma troca de
    // tags — que muda o frontmatter, e portanto o digest — invalida a medida.
    expect(cache.ler('uuid-1', '2026-01-03T00:00:00.000Z')).toBeUndefined();
    expect(cache.ler('uuid-2', '2026-01-02T00:00:00.000Z')).toBeUndefined();
  });

  it('guarda o marcador de dinâmico como qualquer outra medida', () => {
    const cache = criarCacheDeDigesto();
    cache.guardar('uuid-1', 'v1', 'dynamic');

    expect(cache.ler('uuid-1', 'v1')).toBe('dynamic');
  });

  it('descarta o mais antigo ao passar do teto, em vez de crescer sem fim', () => {
    const cache = criarCacheDeDigesto(2);

    cache.guardar('uuid-1', 'v1', medida);
    cache.guardar('uuid-2', 'v1', medida);
    cache.guardar('uuid-3', 'v1', medida);

    expect(cache.tamanho).toBe(2);
    expect(cache.ler('uuid-1', 'v1')).toBeUndefined();
    expect(cache.ler('uuid-2', 'v1')).toEqual(medida);
    expect(cache.ler('uuid-3', 'v1')).toEqual(medida);
  });

  it('regravar a mesma chave não conta como entrada nova', () => {
    const cache = criarCacheDeDigesto(2);

    cache.guardar('uuid-1', 'v1', medida);
    cache.guardar('uuid-1', 'v1', medida);
    cache.guardar('uuid-2', 'v1', medida);

    expect(cache.tamanho).toBe(2);
    expect(cache.ler('uuid-1', 'v1')).toEqual(medida);
  });

  it('esvazia por inteiro', () => {
    const cache = criarCacheDeDigesto();
    cache.guardar('uuid-1', 'v1', medida);

    cache.limpar();

    expect(cache.tamanho).toBe(0);
    expect(cache.ler('uuid-1', 'v1')).toBeUndefined();
  });
});
