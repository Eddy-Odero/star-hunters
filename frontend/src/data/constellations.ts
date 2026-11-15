export interface ConstellationSegment {
  ra1: number;
  dec1: number;
  ra2: number;
  dec2: number;
}

export interface ConstellationDefinition {
  abbr: string;
  name: string;
  centerRa: number;
  centerDec: number;
  segments: readonly ConstellationSegment[];
}

/**
 * Curated IAU constellation stick-figures (bright member stars in J2000 ICRS degrees),
 * covering major seasonal constellations plus key benchmark target constellations.
 */
export const IAU_CONSTELLATIONS: readonly ConstellationDefinition[] = [
  {
    abbr: 'Ori',
    name: 'Orion',
    centerRa: 83.8,
    centerDec: -1.2,
    segments: [
      { ra1: 88.79, dec1: 7.41, ra2: 81.28, dec2: 6.35 },
      { ra1: 88.79, dec1: 7.41, ra2: 85.19, dec2: -1.94 },
      { ra1: 81.28, dec1: 6.35, ra2: 83.0, dec2: -0.3 },
      { ra1: 83.0, dec1: -0.3, ra2: 84.05, dec2: -1.2 },
      { ra1: 84.05, dec1: -1.2, ra2: 85.19, dec2: -1.94 },
      { ra1: 83.0, dec1: -0.3, ra2: 78.63, dec2: -8.2 },
      { ra1: 85.19, dec1: -1.94, ra2: 86.94, dec2: -9.67 },
      { ra1: 78.63, dec1: -8.2, ra2: 86.94, dec2: -9.67 },
    ],
  },
  {
    abbr: 'UMa',
    name: 'Ursa Major',
    centerRa: 178.0,
    centerDec: 55.5,
    segments: [
      { ra1: 206.89, dec1: 49.31, ra2: 200.98, dec2: 54.93 },
      { ra1: 200.98, dec1: 54.93, ra2: 193.51, dec2: 55.96 },
      { ra1: 193.51, dec1: 55.96, ra2: 183.86, dec2: 57.03 },
      { ra1: 183.86, dec1: 57.03, ra2: 178.46, dec2: 53.69 },
      { ra1: 178.46, dec1: 53.69, ra2: 165.46, dec2: 56.38 },
      { ra1: 165.46, dec1: 56.38, ra2: 165.93, dec2: 61.75 },
      { ra1: 165.93, dec1: 61.75, ra2: 183.86, dec2: 57.03 },
    ],
  },
  {
    abbr: 'Cas',
    name: 'Cassiopeia',
    centerRa: 14.0,
    centerDec: 60.5,
    segments: [
      { ra1: 2.29, dec1: 59.15, ra2: 10.13, dec2: 56.54 },
      { ra1: 10.13, dec1: 56.54, ra2: 14.18, dec2: 60.72 },
      { ra1: 14.18, dec1: 60.72, ra2: 21.45, dec2: 60.24 },
      { ra1: 21.45, dec1: 60.24, ra2: 28.6, dec2: 63.67 },
    ],
  },
  {
    abbr: 'Cyg',
    name: 'Cygnus',
    centerRa: 306.0,
    centerDec: 40.0,
    segments: [
      { ra1: 310.36, dec1: 45.28, ra2: 305.56, dec2: 40.26 },
      { ra1: 305.56, dec1: 40.26, ra2: 292.68, dec2: 27.96 },
      { ra1: 296.24, dec1: 45.13, ra2: 305.56, dec2: 40.26 },
      { ra1: 305.56, dec1: 40.26, ra2: 311.55, dec2: 33.97 },
    ],
  },
  {
    abbr: 'Lyr',
    name: 'Lyra',
    centerRa: 283.5,
    centerDec: 36.5,
    segments: [
      { ra1: 279.23, dec1: 38.78, ra2: 281.08, dec2: 37.61 },
      { ra1: 281.08, dec1: 37.61, ra2: 282.52, dec2: 33.36 },
      { ra1: 282.52, dec1: 33.36, ra2: 284.74, dec2: 32.69 },
      { ra1: 284.74, dec1: 32.69, ra2: 283.63, dec2: 36.9 },
      { ra1: 283.63, dec1: 36.9, ra2: 281.08, dec2: 37.61 },
    ],
  },
  {
    abbr: 'Tau',
    name: 'Taurus',
    centerRa: 68.0,
    centerDec: 18.0,
    segments: [
      { ra1: 81.57, dec1: 28.61, ra2: 68.98, dec2: 16.51 },
      { ra1: 68.98, dec1: 16.51, ra2: 67.15, dec2: 15.96 },
      { ra1: 67.15, dec1: 15.96, ra2: 64.95, dec2: 15.63 },
      { ra1: 64.95, dec1: 15.63, ra2: 65.73, dec2: 17.54 },
      { ra1: 65.73, dec1: 17.54, ra2: 67.17, dec2: 19.18 },
      { ra1: 67.17, dec1: 19.18, ra2: 84.41, dec2: 21.14 },
    ],
  },
  {
    abbr: 'Aur',
    name: 'Auriga',
    centerRa: 82.0,
    centerDec: 39.0,
    segments: [
      { ra1: 79.17, dec1: 46.0, ra2: 89.88, dec2: 44.95 },
      { ra1: 89.88, dec1: 44.95, ra2: 89.93, dec2: 37.21 },
      { ra1: 89.93, dec1: 37.21, ra2: 81.57, dec2: 28.61 },
      { ra1: 81.57, dec1: 28.61, ra2: 74.25, dec2: 33.17 },
      { ra1: 74.25, dec1: 33.17, ra2: 79.17, dec2: 46.0 },
    ],
  },
  {
    abbr: 'Gem',
    name: 'Gemini',
    centerRa: 108.0,
    centerDec: 23.0,
    segments: [
      { ra1: 113.65, dec1: 31.89, ra2: 116.33, dec2: 28.03 },
      { ra1: 113.65, dec1: 31.89, ra2: 101.32, dec2: 25.13 },
      { ra1: 101.32, dec1: 25.13, ra2: 95.74, dec2: 22.51 },
      { ra1: 116.33, dec1: 28.03, ra2: 109.2, dec2: 21.98 },
      { ra1: 109.2, dec1: 21.98, ra2: 99.43, dec2: 16.4 },
    ],
  },
  {
    abbr: 'Leo',
    name: 'Leo',
    centerRa: 162.0,
    centerDec: 16.5,
    segments: [
      { ra1: 152.09, dec1: 11.97, ra2: 151.83, dec2: 16.76 },
      { ra1: 151.83, dec1: 16.76, ra2: 154.99, dec2: 19.84 },
      { ra1: 154.99, dec1: 19.84, ra2: 154.17, dec2: 23.42 },
      { ra1: 154.99, dec1: 19.84, ra2: 168.53, dec2: 20.52 },
      { ra1: 168.53, dec1: 20.52, ra2: 177.26, dec2: 14.57 },
      { ra1: 177.26, dec1: 14.57, ra2: 168.56, dec2: 15.43 },
      { ra1: 168.56, dec1: 15.43, ra2: 152.09, dec2: 11.97 },
    ],
  },
  {
    abbr: 'CMa',
    name: 'Canis Major',
    centerRa: 105.0,
    centerDec: -22.5,
    segments: [
      { ra1: 101.29, dec1: -16.72, ra2: 95.67, dec2: -17.96 },
      { ra1: 101.29, dec1: -16.72, ra2: 104.66, dec2: -28.97 },
      { ra1: 104.66, dec1: -28.97, ra2: 107.1, dec2: -26.39 },
      { ra1: 107.1, dec1: -26.39, ra2: 111.02, dec2: -29.3 },
      { ra1: 104.66, dec1: -28.97, ra2: 105.76, dec2: -27.93 },
    ],
  },
  {
    abbr: 'Pup',
    name: 'Puppis',
    centerRa: 120.5,
    centerDec: -26.0,
    segments: [
      { ra1: 120.9, dec1: -40.0, ra2: 117.32, dec2: -24.86 },
      { ra1: 117.32, dec1: -24.86, ra2: 121.89, dec2: -24.3 },
      { ra1: 121.89, dec1: -24.3, ra2: 126.52, dec2: -32.8 },
      { ra1: 120.9, dec1: -40.0, ra2: 109.29, dec2: -37.1 },
    ],
  },
  {
    abbr: 'Sco',
    name: 'Scorpius',
    centerRa: 252.0,
    centerDec: -29.0,
    segments: [
      { ra1: 241.36, dec1: -19.81, ra2: 240.08, dec2: -22.62 },
      { ra1: 240.08, dec1: -22.62, ra2: 247.35, dec2: -26.43 },
      { ra1: 247.35, dec1: -26.43, ra2: 252.54, dec2: -34.29 },
      { ra1: 252.54, dec1: -34.29, ra2: 263.4, dec2: -37.1 },
      { ra1: 263.4, dec1: -37.1, ra2: 264.33, dec2: -43.0 },
    ],
  },
  {
    abbr: 'Oph',
    name: 'Ophiuchus',
    centerRa: 260.0,
    centerDec: -4.0,
    segments: [
      { ra1: 263.73, dec1: 12.56, ra2: 265.87, dec2: 4.57 },
      { ra1: 263.73, dec1: 12.56, ra2: 254.42, dec2: 9.38 },
      { ra1: 254.42, dec1: 9.38, ra2: 243.59, dec2: -3.69 },
      { ra1: 243.59, dec1: -3.69, ra2: 257.59, dec2: -15.72 },
      { ra1: 257.59, dec1: -15.72, ra2: 265.87, dec2: 4.57 },
    ],
  },
  {
    abbr: 'Aql',
    name: 'Aquila',
    centerRa: 295.0,
    centerDec: 6.5,
    segments: [
      { ra1: 296.56, dec1: 10.61, ra2: 297.7, dec2: 8.87 },
      { ra1: 297.7, dec1: 8.87, ra2: 298.83, dec2: 6.41 },
      { ra1: 297.7, dec1: 8.87, ra2: 286.35, dec2: 13.86 },
      { ra1: 297.7, dec1: 8.87, ra2: 291.37, dec2: 3.11 },
    ],
  },
  {
    abbr: 'Cru',
    name: 'Crux',
    centerRa: 187.5,
    centerDec: -60.5,
    segments: [
      { ra1: 186.65, dec1: -63.1, ra2: 187.79, dec2: -57.11 },
      { ra1: 183.79, dec1: -58.75, ra2: 191.93, dec2: -59.69 },
    ],
  },
  {
    abbr: 'Cen',
    name: 'Centaurus',
    centerRa: 208.0,
    centerDec: -47.0,
    segments: [
      { ra1: 219.9, dec1: -60.83, ra2: 210.96, dec2: -60.37 },
      { ra1: 210.96, dec1: -60.37, ra2: 204.97, dec2: -53.47 },
      { ra1: 204.97, dec1: -53.47, ra2: 211.67, dec2: -36.37 },
      { ra1: 211.67, dec1: -36.37, ra2: 182.09, dec2: -50.72 },
    ],
  },
  {
    abbr: 'Dra',
    name: 'Draco',
    centerRa: 256.0,
    centerDec: 62.0,
    segments: [
      { ra1: 269.15, dec1: 51.49, ra2: 262.61, dec2: 52.3 },
      { ra1: 262.61, dec1: 52.3, ra2: 264.24, dec2: 55.18 },
      { ra1: 264.24, dec1: 55.18, ra2: 268.38, dec2: 56.87 },
      { ra1: 268.38, dec1: 56.87, ra2: 269.15, dec2: 51.49 },
      { ra1: 257.19, dec1: 65.71, ra2: 245.99, dec2: 61.51 },
      { ra1: 245.99, dec1: 61.51, ra2: 231.23, dec2: 58.97 },
      { ra1: 231.23, dec1: 58.97, ra2: 211.1, dec2: 64.38 },
    ],
  },
  {
    abbr: 'Ind',
    name: 'Indus',
    centerRa: 318.0,
    centerDec: -52.5,
    segments: [
      { ra1: 309.39, dec1: -47.29, ra2: 313.7, dec2: -58.45 },
      { ra1: 313.7, dec1: -58.45, ra2: 330.14, dec2: -56.79 },
      { ra1: 330.14, dec1: -56.79, ra2: 309.39, dec2: -47.29 },
    ],
  },
  {
    abbr: 'And',
    name: 'Andromeda',
    centerRa: 17.5,
    centerDec: 37.5,
    segments: [
      { ra1: 2.1, dec1: 29.09, ra2: 9.83, dec2: 30.86 },
      { ra1: 9.83, dec1: 30.86, ra2: 17.43, dec2: 35.62 },
      { ra1: 17.43, dec1: 35.62, ra2: 30.97, dec2: 42.33 },
    ],
  },
  {
    abbr: 'Psc',
    name: 'Pisces',
    centerRa: 10.0,
    centerDec: 7.0,
    segments: [
      { ra1: 29.9, dec1: 2.76, ra2: 14.44, dec2: 7.89 },
      { ra1: 14.44, dec1: 7.89, ra2: 357.83, dec2: 5.62 },
      { ra1: 357.83, dec1: 5.62, ra2: 354.99, dec2: 5.63 },
      { ra1: 29.9, dec1: 2.76, ra2: 22.87, dec2: 15.35 },
    ],
  },
];
