/**
 * Planilha CSV (Excel, Google Planilhas ou o sistema antigo): separador ; , ou tab, aspas e quebras de
 * linha dentro das aspas. O Excel no Brasil costuma salvar em Windows-1252: se não for UTF-8, lê assim.
 */

export async function readCsvFile(file: File): Promise<string> {
  const bytes = await file.arrayBuffer();
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}

export function parseCsv(input: string): string[][] {
  const text = input.replace(/^﻿/, '');
  const first = text.split(/\r?\n/, 1)[0] ?? '';
  const sep = ([';', ',', '\t'] as const).map((s) => [s, first.split(s).length] as const).sort((a, b) => b[1] - a[1])[0][0];
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch !== '"') cell += ch;
      else if (text[i + 1] === '"') {
        cell += '"';
        i++;
      } else quoted = false;
    } else if (ch === '"') quoted = true;
    else if (ch === sep) {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim()));
}

/** Qual coluna é o nome, o celular e o aniversário, pelo cabeçalho (-1 = não achou). */
export function guessColumns(header: string[]): { name: number; phone: number; birth: number } {
  const norm = header.map((h) =>
    h
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .trim(),
  );
  const find = (re: RegExp) => norm.findIndex((h) => re.test(h));
  return { name: find(/^(nome|name|cliente)/), phone: find(/(celular|telefone|whats|fone|phone|contato|tel)/), birth: find(/(nasc|aniver|birth)/) };
}
