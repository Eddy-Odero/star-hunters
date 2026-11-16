export interface NasaCurtainImage {
  id: string;
  src: string;
  title: string;
  attribution: string;
  nasaId: string;
}

export const NASA_CURTAIN_IMAGES: readonly NasaCurtainImage[] = [
  {
    id: 'jwst-nebulous-cauldron',
    src: '/curtain-backgrounds/jwst-nebulous-cauldron-3k.jpg',
    title: 'Stars Brewing in a Nebulous Cauldron',
    attribution: 'NASA, ESA, CSA, STScI (JWST)',
    nasaId: 'flickr-55604475252',
  },
  {
    id: 'hubble-dwarf-galaxies',
    src: '/curtain-backgrounds/hubble-dwarf-galaxies-3k.jpg',
    title: 'Case of Missing Oxygen in Nearby Dwarf Galaxies',
    attribution: 'NASA, ESA, STScI (Hubble)',
    nasaId: 'flickr-55627672149',
  },
  {
    id: 'hubble-m88-virgo',
    src: '/curtain-backgrounds/hubble-m88-virgo-3k.jpg',
    title: 'Spiral Galaxy M88 in the Virgo Cluster',
    attribution: 'NASA, ESA, STScI (Hubble)',
    nasaId: 'flickr-55301169976',
  },
  {
    id: 'hubble-cloudy-cluster',
    src: '/curtain-backgrounds/jwst-cloudy-cluster-3k.jpg',
    title: 'Hubble Surveys Cloudy Star Cluster',
    attribution: 'NASA, ESA, STScI (Hubble)',
    nasaId: 'flickr-54782043516',
  },
  {
    id: 'jwst-ngc1385-composite',
    src: '/curtain-backgrounds/jwst-ngc1385-composite-3k.jpg',
    title: 'NGC 1385 (Chandra + Hubble + Webb)',
    attribution: 'NASA, CXC, ESA, CSA, STScI',
    nasaId: 'flickr-55488035398',
  },
  {
    id: 'jwst-sombrero-miri',
    src: '/curtain-backgrounds/jwst-sombrero-miri-3k.jpg',
    title: 'Sombrero Galaxy (M104) in Mid-Infrared',
    attribution: 'NASA, ESA, CSA, STScI (JWST MIRI)',
    nasaId: 'flickr-54163774891',
  },
  {
    id: 'jwst-saturn-nircam',
    src: '/curtain-backgrounds/jwst-saturn-nircam-3k.jpg',
    title: 'Saturn Wide-View in Near-Infrared',
    attribution: 'NASA, ESA, CSA, STScI (JWST NIRCam)',
    nasaId: 'flickr-55167269212',
  },
  {
    id: 'jwst-m83-panoramic',
    src: '/curtain-backgrounds/jwst-m83-panoramic-3k.jpg',
    title: 'Spiral Galaxy M83 Infrared Structure',
    attribution: 'NASA, ESA, CSA, STScI (JWST)',
    nasaId: 'flickr-54458091051',
  },
  {
    id: 'jwst-starburst-ir',
    src: '/curtain-backgrounds/jwst-starburst-ir-3k.jpg',
    title: 'A Starburst Shines in Infrared',
    attribution: 'NASA, ESA, CSA, STScI (JWST)',
    nasaId: 'flickr-54626159771',
  },
  {
    id: 'jwst-star-cluster-cradle',
    src: '/curtain-backgrounds/jwst-star-cluster-cradle-3k.jpg',
    title: 'Cradles of Massive Star Clusters',
    attribution: 'NASA, ESA, CSA, STScI (JWST)',
    nasaId: 'flickr-55252854454',
  },
  {
    id: 'jwst-trappist1e',
    src: '/curtain-backgrounds/jwst-trappist1e-3k.jpg',
    title: 'Habitable-Zone Exoplanet TRAPPIST-1 e',
    attribution: 'NASA, ESA, CSA, STScI (JWST)',
    nasaId: 'flickr-54774029725',
  },
  {
    id: 'nasa-artemis-earth-view',
    src: '/curtain-backgrounds/nasa-artemis-earth-view-hd.jpg',
    title: 'Earthrise Beyond Orion Spacecraft',
    attribution: 'NASA (Artemis Imagery)',
    nasaId: 'amf-art002e023506',
  },
  {
    id: 'nasa-artemis-ii-launch',
    src: '/curtain-backgrounds/nasa-artemis-ii-launch-hd.jpg',
    title: 'Artemis II Launch Complex View',
    attribution: 'NASA (Kennedy Space Center)',
    nasaId: 'artemis-ii-launch-19',
  },
  {
    id: 'nasa-iss-japan-platform',
    src: '/curtain-backgrounds/nasa-iss-japan-platform-hd.jpg',
    title: 'Orbital Horizon Above Exposed Facility',
    attribution: 'NASA / Johnson Space Center',
    nasaId: 'gmt297_flyover-3',
  },
  {
    id: 'nasa-iss-research-power',
    src: '/curtain-backgrounds/nasa-iss-research-power-hd.jpg',
    title: 'International Space Station Research & Solar Arrays',
    attribution: 'NASA / Johnson Space Center',
    nasaId: 'nasa-3502384-3',
  },
  {
    id: 'nasa-iss-small-packages',
    src: '/curtain-backgrounds/nasa-iss-small-packages-hd.jpg',
    title: 'Orbital Earth Limb & Space Station Truss',
    attribution: 'NASA / Johnson Space Center',
    nasaId: 'nasa2007945-2',
  },
] as const;

export function pickRandomNasaCurtainImage(rng: () => number = Math.random): NasaCurtainImage {
  const index = Math.min(
    NASA_CURTAIN_IMAGES.length - 1,
    Math.max(0, Math.floor(rng() * NASA_CURTAIN_IMAGES.length)),
  );
  return NASA_CURTAIN_IMAGES[index];
}
