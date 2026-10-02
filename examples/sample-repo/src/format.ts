export function formatReport(report: { count: number; sum: number; mean: number }): string {
  return [`count: ${report.count}`, `sum:   ${report.sum}`, `mean:  ${report.mean.toFixed(2)}`].join('\n');
}
