import React from 'react';
import { useSkyExplorer } from '../context/SkyExplorerContext';

export interface TourTargetInfo {
  slug: string;
  label: string;
  category: string;
  badgeColor: string;
  discoveryGuide: string;
  whatToLookFor: string;
}

const TOUR_TARGETS: ReadonlyArray<TourTargetInfo> = [
  {
    slug: 'wise_0855',
    label: 'WISE 0855',
    category: 'Brown Dwarf / Planet X Candidate',
    badgeColor: '#f472b6',
    discoveryGuide:
      'An ultra-cold Y dwarf located only ~7.2 light-years away, shining brightly in deep infrared.',
    whatToLookFor:
      'Blink Pass 1 vs Pass 2 in the 3.8–5.0 µm cold band to spot high proper motion against background stars.',
  },
  {
    slug: 'barnards_star',
    label: "Barnard's Star",
    category: 'High Proper Motion Star',
    badgeColor: '#38bdf8',
    discoveryGuide: 'The star with the largest known proper motion across the night sky.',
    whatToLookFor:
      'Switch to Subtract mode (Pass B − Pass A) to see the distinct dipole offset caused by stellar motion.',
  },
  {
    slug: 'epsilon_indi_b',
    label: 'Epsilon Indi B',
    category: 'T-Dwarf Binary Pair',
    badgeColor: '#fbbf24',
    discoveryGuide:
      'A wide separation binary brown dwarf companion orbiting a nearby K-type star system.',
    whatToLookFor: 'Inspect the dual point sources in the methane absorption bands (2.4–3.8 µm).',
  },
  {
    slug: 'rw_aurigae',
    label: 'RW Aurigae',
    category: 'Variable Star',
    badgeColor: '#a78bfa',
    discoveryGuide:
      'A young T Tauri binary star system renowned for episodic dimming events and mass ejection.',
    whatToLookFor:
      'Use non-looping playback across epochs to watch flux variability and outbursts.',
  },
  {
    slug: 'r_draconis',
    label: 'R Draconis',
    category: 'Mira Variable Giant',
    badgeColor: '#fb923c',
    discoveryGuide:
      'An asymptotic giant branch pulsating variable star with a prominent ~245-day optical/IR cycle.',
    whatToLookFor:
      'Compare flux magnitude across SPHEREx epochs using the Co-Add stack and spectral inspector.',
  },
  {
    slug: 'comet_3i_atlas',
    label: 'Comet 3I/ATLAS',
    category: 'Solar System Interloper',
    badgeColor: '#34d399',
    discoveryGuide:
      'An active interstellar or outer solar system comet exhibiting a distinct dust coma and tail.',
    whatToLookFor:
      'Click the moving nucleus to trace trajectory waypoints and examine trail residuals in difference mode.',
  },
];

export const TargetTourBar: React.FC = () => {
  const { activePresetSlug, selectPreset } = useSkyExplorer();

  return (
    <div className="target-tour-bar" role="region" aria-label="Target Tour Carousel">
      <div className="tour-header">
        <h3>Showcase Tour Carousel</h3>
        <p className="tour-subtitle">
          Select an astronomical target to load multi-epoch SPHEREx telemetry:
        </p>
      </div>
      <div className="tour-cards-grid">
        {TOUR_TARGETS.map((target) => {
          const isActive = activePresetSlug === target.slug;
          return (
            <button
              key={target.slug}
              type="button"
              className={isActive ? 'tour-card active' : 'tour-card'}
              onClick={() => selectPreset(target.slug)}
              aria-pressed={isActive}
            >
              <div className="tour-card-top">
                <span className="tour-title">{target.label}</span>
                <span
                  className="tour-badge"
                  style={{ borderColor: target.badgeColor, color: target.badgeColor }}
                >
                  {target.category}
                </span>
              </div>
              <p className="tour-guide">{target.discoveryGuide}</p>
              <p className="tour-tip">
                <strong>Tip:</strong> {target.whatToLookFor}
              </p>
            </button>
          );
        })}
      </div>
    </div>
  );
};

export default TargetTourBar;
