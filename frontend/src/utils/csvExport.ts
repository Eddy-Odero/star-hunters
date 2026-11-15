import type { SpectrumPayload } from '../types/contracts';

export function formatSpectrumCsv(spectrum: SpectrumPayload): string {
  const header = 'band_index,detector,wavelength_um,flux,variance,flagged';
  const rows = spectrum.channels.map((ch) =>
    [
      ch.band_index,
      ch.detector,
      ch.wavelength_um.toFixed(4),
      ch.flux.toExponential(6),
      ch.variance.toExponential(6),
      ch.flagged ? 'true' : 'false',
    ].join(','),
  );
  return [header, ...rows].join('\n');
}

export function downloadSpectrumCsv(spectrum: SpectrumPayload, targetSlugOrId: string): void {
  const csvContent = formatSpectrumCsv(spectrum);
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.setAttribute('href', url);
  link.setAttribute('download', `${targetSlugOrId}_102band_spectrum.csv`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
