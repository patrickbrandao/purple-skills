import { describe, expect, it } from 'vitest';
import { ApiError, isNotFound } from './api.js';

/**
 * Quando um erro de leitura justifica tirar a pessoa de uma ficha já carregada
 * (`tasks/049`). O Salvar da skill saía do editor em **qualquer** falha da
 * releitura final — e sair desmonta a tela com tudo o que ainda estava
 * pendente. Só o 404 diz que a skill ficou fora de alcance (removida, ou a
 * conta deixou de vê-la: o servidor responde 404 aos dois).
 */
describe('isNotFound', () => {
  it('404 é fora de alcance: a skill sumiu ou a conta deixou de vê-la', () => {
    expect(isNotFound(new ApiError('Skill não encontrada', 404, 'not_found'))).toBe(true);
  });

  it('sessão vencida (401) não é: quem entra de novo salva de onde parou', () => {
    expect(isNotFound(new ApiError('Sessão expirada ou ausente', 401, 'unauthorized'))).toBe(false);
  });

  it('403, 409 e 5xx não são', () => {
    expect(isNotFound(new ApiError('Troque a senha temporária antes de continuar', 403, 'password_change_required'))).toBe(false);
    expect(isNotFound(new ApiError('Já existe', 409, 'conflict'))).toBe(false);
    expect(isNotFound(new ApiError('Erro 500', 500))).toBe(false);
    expect(isNotFound(new ApiError('Erro 502', 502))).toBe(false);
  });

  it('queda de rede (o `fetch` rejeita com TypeError) não é', () => {
    expect(isNotFound(new TypeError('Failed to fetch'))).toBe(false);
  });

  it('o que não é erro da API não é — nem um objeto com `status: 404`', () => {
    expect(isNotFound(undefined)).toBe(false);
    expect(isNotFound(null)).toBe(false);
    expect(isNotFound('404')).toBe(false);
    expect(isNotFound({ status: 404 })).toBe(false);
    expect(isNotFound(new Error('404'))).toBe(false);
  });
});
