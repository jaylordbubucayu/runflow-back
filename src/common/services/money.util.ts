/**
 * Money helpers - do arithmetic in centavos (integers) to avoid
 * floating-point drift; DB columns stay DECIMAL(10,2) for storage/display.
 * Per §4.3 of the architecture doc, PayMongo's API itself works in centavos.
 */
export function pesosToCentavos(pesos: number | string): number {
  return Math.round(Number(pesos) * 100);
}

export function centavosToPesos(centavos: number): string {
  return (centavos / 100).toFixed(2);
}
