// Adianta o relógio de todo o processo em CLOCK_SHIFT_DAYS dias. Usado no GitHub para caçar testes que
// dependem da data: CLOCK_SHIFT_DAYS=120 NODE_OPTIONS="--import ./tools/clock-shift.mjs" npm test
const OFFSET = Number(process.env.CLOCK_SHIFT_DAYS || 0) * 86400000;
const Real = Date;
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
