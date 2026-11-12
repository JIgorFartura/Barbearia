import { mock } from 'node:test';

/**
 * Relógio dos testes. Teste com data fixa ("dia 02/11, 10h") para o relógio do processo num instante
 * conhecido, para o resultado não depender do dia nem da hora em que roda. Teste com datas relativas
 * ("daqui a 2 dias") pode usar o relógio de verdade.
 *
 * Para caçar dependência de data, o GitHub também roda a suíte com o relógio adiantado
 * (tools/clock-shift.mjs): um teste de data fixa que esquecer de parar o relógio quebra ali.
 */
export const TEST_NOW = '2026-11-01T15:00:00Z';

/** Para o relógio (Date) do processo de teste no instante dado. Chamar no topo do arquivo de teste. */
export function freezeClock(iso: string = TEST_NOW): void {
  mock.timers.enable({ apis: ['Date'], now: new Date(iso) });
}
