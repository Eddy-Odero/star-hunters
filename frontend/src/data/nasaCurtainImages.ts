export interface NasaCurtainImage {
  id: string;
  src: string;
  title: string;
  attribution: string;
  nasaId: string;
}

export const NASA_CURTAIN_IMAGES: readonly NasaCurtainImage[] = [
  {
    id: 'carina-jwst',
    src: '/curtain-backgrounds/carina-cliffs-jwst.jpg',
    title: 'Cosmic Cliffs in the Carina Nebula (NGC 3324)',
    attribution: 'NASA, ESA, CSA, and STScI — JWST NIRCam',
    nasaId: 'carina_nebula',
  },
  {
    id: 'galactic-center-spitzer',
    src: '/curtain-backgrounds/galactic-center-spitzer.jpg',
    title: 'Stars Gather in Downtown Milky Way',
    attribution: 'NASA / JPL-Caltech — Spitzer IRAC',
    nasaId: 'PIA13932',
  },
  {
    id: 'eagle-nebula-wise',
    src: '/curtain-backgrounds/eagle-nebula-wise.jpg',
    title: 'The Eagle Nebula in Infrared',
    attribution: 'NASA / JPL-Caltech — WISE',
    nasaId: 'PIA25433',
  },
  {
    id: 'galaxy-cauldron-spitzer',
    src: '/curtain-backgrounds/galaxy-cauldron-spitzer.jpg',
    title: 'A Cauldron of Stars at the Galactic Center',
    attribution: 'NASA / JPL-Caltech — Spitzer Space Telescope',
    nasaId: 'PIA03654',
  },
  {
    id: 'andromeda-ir-herschel',
    src: '/curtain-backgrounds/andromeda-ir-herschel.jpg',
    title: 'Andromeda Galaxy (M31) Dust Rings in Far-Infrared',
    attribution: 'ESA / NASA / JPL-Caltech / C. Clark (STScI) — Herschel',
    nasaId: 'PIA25163',
  },
  {
    id: 'orion-ir-spitzer',
    src: '/curtain-backgrounds/orion-ir-spitzer.jpg',
    title: 'Orion Nebula Rainbow of Infrared Light',
    attribution: 'NASA / ESA / JPL-Caltech / IRAM — Spitzer & Hubble',
    nasaId: 'PIA13959',
  },
] as const;

export function pickRandomNasaCurtainImage(rng: () => number = Math.random): NasaCurtainImage {
  const index = Math.min(
    NASA_CURTAIN_IMAGES.length - 1,
    Math.max(0, Math.floor(rng() * NASA_CURTAIN_IMAGES.length)),
  );
  return NASA_CURTAIN_IMAGES[index];
}
