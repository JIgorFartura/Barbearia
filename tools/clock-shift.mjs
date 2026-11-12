// Relógio de mentira para o processo inteiro (servidor, testes e a demonstração), em dois modos:
//   CLOCK_SHIFT_DAYS=120  adianta o relógio (no GitHub, para caçar teste que depende da data);
//   CLOCK_AT=2026-11-04T13:00:00Z  começa nesse instante e anda normalmente (testes de ponta a ponta).
// Uso: NODE_OPTIONS="--import ./tools/clock-shift.mjs" npm test
const Real = Date;
const OFFSET = process.env.CLOCK_AT ? Real.parse(process.env.CLOCK_AT) - Real.now() : Number(process.env.CLOCK_SHIFT_DAYS || 0) * 86400000;
class Shifted extends Real {
  constructor(...a) {
    if (a.length === 0) super(Real.now() + OFFSET);
    else super(...a);
  }
  static now() {
    return Real.now() + OFFSET;
  }
}
globalThis.Date = Shifted;
