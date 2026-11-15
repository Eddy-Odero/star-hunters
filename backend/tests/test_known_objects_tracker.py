"""ISS-07: known-object synthesis, WISE/Gaia cross-match, proper motion propagation, ranking."""

from __future__ import annotations

import math
import unittest

from app.models.contracts import KnownCelestialObject
from app.services.known_objects_tracker import (
    GAIA_J2016_MJD,
    angular_separation_arcsec,
    build_known_objects,
    classify_wise_source,
    match_wise_to_gaia,
    propagate_position,
)

RA0, DEC0 = 133.7951, -7.2451
SCALE_DEG = round((5.0 / 60.0) / 256.0, 7)
WCS = {
    "width": 256,
    "height": 256,
    "crval": [RA0, DEC0],
    "crpix": [128.0, 128.0],
    "cdelt": [-SCALE_DEG, SCALE_DEG],
}
PX_ARCSEC = SCALE_DEG * 3600.0
EPOCHS = [
    {"epoch_id": "pass_1", "mjd": 60810.5},
    {"epoch_id": "pass_2", "mjd": 60993.2},
]
BASELINE_YR = (60993.2 - 60810.5) / 365.25


def offset_arcsec(ra: float, dec: float, d_east: float, d_north: float) -> tuple[float, float]:
    return ra + d_east / 3600.0 / math.cos(math.radians(dec)), dec + d_north / 3600.0


def gaia(sid, d_east=0.0, d_north=0.0, pmra=0.0, pmdec=0.0, g=15.0):
    ra, dec = offset_arcsec(RA0, DEC0, d_east, d_north)
    return {
        "source_id": sid,
        "ra": ra,
        "dec": dec,
        "g_mag": g,
        "bp_rp": 1.0,
        "pmra": pmra,
        "pmdec": pmdec,
    }


def wise(sid, d_east=0.0, d_north=0.0, color=0.3, w2=14.0, pmra=0.0, pmdec=0.0):
    ra, dec = offset_arcsec(RA0, DEC0, d_east, d_north)
    return {
        "source_id": sid,
        "ra": ra,
        "dec": dec,
        "w1_mag": w2 + color,
        "w2_mag": w2,
        "w1_w2_color": color,
        "pmra": pmra,
        "pmdec": pmdec,
    }


def build(gaia_rows=(), wise_rows=(), most_rows=(), **kw):
    kw.setdefault("gaia_position_epoch_mjd", EPOCHS[0]["mjd"])
    return build_known_objects(gaia_rows, wise_rows, most_rows, WCS, EPOCHS, **kw)


class TestKnownObjectsTracker(unittest.TestCase):
    def test_proper_motion_propagation_matches_vector_and_round_trips(self) -> None:
        # Barnard's Star-like: pmra -798.6, pmdec +10328 mas/yr over 2 years
        ra, dec = propagate_position(269.4521, 4.6934, -798.58, 10328.12, 2.0)
        self.assertAlmostEqual((dec - 4.6934) * 3600.0, 20.65624, places=4)
        dra = (ra - 269.4521) * math.cos(math.radians(4.6934)) * 3600.0
        self.assertAlmostEqual(dra, -1.59716, places=3)
        back = propagate_position(ra, dec, -798.58, 10328.12, -2.0)
        self.assertLess(angular_separation_arcsec(269.4521, 4.6934, *back), 1e-3)
        # J2016.0 -> epoch: dt is (mjd - 57388.5)/365.25 years
        self.assertAlmostEqual((60810.5 - GAIA_J2016_MJD) / 365.25, 3422.0 / 365.25, places=9)

    def test_wise_gaia_crossmatch_uses_2p5_arcsec_radius_and_is_one_to_one(self) -> None:
        g = [gaia("G1"), gaia("G2", d_east=30.0)]
        w = [wise("W_in", d_north=2.4), wise("W_out", d_east=30.0, d_north=2.6)]
        matches = match_wise_to_gaia(w, g)
        self.assertEqual(set(matches), {"W_in"})
        self.assertEqual(matches["W_in"][0], "G1")
        self.assertAlmostEqual(matches["W_in"][1], 2.4, places=2)
        # two WISE sources near one Gaia source: only the closest claims it
        two = match_wise_to_gaia([wise("A", d_north=1.0), wise("B", d_north=2.0)], [gaia("G1")])
        self.assertEqual(list(two), ["A"])
        # fast mover: Gaia position propagated to the WISE epoch lets it match
        mover = gaia("GM", pmdec=10000.0)  # 10 arcsec/yr
        w_late = wise("WM", d_north=10.0 * 2.0)  # WISE saw it 2 years after Gaia
        self.assertEqual(match_wise_to_gaia([w_late], [mover]), {})
        late_mjd = GAIA_J2016_MJD + 2.0 * 365.25
        self.assertIn("WM", match_wise_to_gaia([w_late], [mover], wise_epoch_mjd=late_mjd))

    def test_classification_optical_ir_star_vs_infrared_only_brown_dwarf(self) -> None:
        red = wise("R", color=0.8)
        self.assertEqual(classify_wise_source(red, has_gaia_match=False), "brown_dwarf_candidate")
        self.assertEqual(
            classify_wise_source(wise("R2", color=0.79), has_gaia_match=False), "infrared_source"
        )
        self.assertEqual(classify_wise_source(red, has_gaia_match=True), "optical_ir_star")

        objs = build(
            [gaia("G1", d_east=10.0)],
            [
                wise("W_match", d_east=10.0, d_north=1.0, color=1.4),  # has optical counterpart
                wise("W_bd", d_east=-40.0, color=2.5),  # IR-only red
                wise("W_plain", d_east=-60.0, color=0.2),
            ],
        )
        by_id = {o["object_id"]: o for o in objs}
        self.assertNotIn("wise:W_match", by_id, "matched WISE source merges into its Gaia star")
        self.assertEqual(by_id["gaia:G1"]["w1_w2_color"], 1.4)
        self.assertEqual(by_id["gaia:G1"]["object_type"], "star")
        self.assertEqual(by_id["wise:W_bd"]["object_type"], "brown_dwarf_candidate")
        self.assertEqual(by_id["wise:W_plain"]["object_type"], "infrared_source")

    def test_every_object_has_an_epoch_position_for_every_epoch_and_validates(self) -> None:
        most = [
            {
                "object_name": "Ceres",
                "epoch_id": "pass_1",
                "ra": RA0,
                "dec": DEC0,
                "x": 0,
                "y": 0,
                "v_mag": 8.5,
            },
        ]  # ephemeris only for pass_1: pass_2 must still be filled
        objs = build(
            [gaia("G1", d_east=5.0, pmra=300.0), gaia("G2", d_east=-20.0)],
            [wise("W1", d_north=30.0, color=1.9)],
            most,
        )
        self.assertEqual(len(objs), 4)
        for obj in objs:
            self.assertEqual([p["epoch_id"] for p in obj["epoch_positions"]], ["pass_1", "pass_2"])
            self.assertEqual([p["mjd"] for p in obj["epoch_positions"]], [60810.5, 60993.2])
            self.assertEqual(obj["ra"], obj["epoch_positions"][0]["ra"])
            self.assertEqual(obj["x"], obj["epoch_positions"][0]["x"])
            KnownCelestialObject.model_validate(obj)  # JSON-schema + dataclass round trip

    def test_high_proper_motion_star_and_brown_dwarf_move_by_their_proper_motion_vector(
        self,
    ) -> None:
        barnard = {**gaia("B", pmra=-798.58, pmdec=10328.12, g=9.5), "object_id": "gaia:barnard"}
        w0855 = {
            **wise("W0855", d_east=-60.0, color=3.5, pmra=-8000.0, pmdec=700.0, w2=13.9),
            "object_id": "wise:0855",
        }
        objs = build([barnard], [w0855])
        by_id = {o["object_id"]: o for o in objs}

        for oid, (pmra, pmdec) in {
            "gaia:barnard": (-798.58, 10328.12),
            "wise:0855": (-8000.0, 700.0),
        }.items():
            obj = by_id[oid]
            p1, p2 = obj["epoch_positions"]
            self.assertNotEqual((p1["x"], p1["y"]), (p2["x"], p2["y"]), f"{oid} must move")
            exp_dra = pmra / 1000.0 * BASELINE_YR
            exp_ddec = pmdec / 1000.0 * BASELINE_YR
            mv = obj["motion_vector"]
            self.assertAlmostEqual(mv["dra_arcsec"], exp_dra, delta=2e-3)
            self.assertAlmostEqual(mv["ddec_arcsec"], exp_ddec, delta=2e-3)
            # pixel displacement = arcsec displacement / plate scale (x grows westward: -dRA)
            self.assertAlmostEqual(p2["x"] - p1["x"], -exp_dra / PX_ARCSEC, delta=0.02)
            self.assertAlmostEqual(p2["y"] - p1["y"], exp_ddec / PX_ARCSEC, delta=0.02)
            self.assertAlmostEqual(
                obj["proper_motion_arcsec_yr"], math.hypot(pmra, pmdec) / 1000, 3
            )
        self.assertGreater(
            math.hypot(
                by_id["gaia:barnard"]["motion_vector"]["dx_px"],
                by_id["gaia:barnard"]["motion_vector"]["dy_px"],
            ),
            4.0,
        )

    def test_gaia_positions_are_propagated_from_j2016_when_requested(self) -> None:
        star = gaia("S", pmdec=1000.0)  # 1 arcsec/yr
        (obj,) = build_known_objects([star], [], [], WCS, EPOCHS)  # default J2016.0 reference
        dt = (60810.5 - GAIA_J2016_MJD) / 365.25
        self.assertAlmostEqual((obj["dec"] - star["dec"]) * 3600.0, 1.0 * dt, places=3)

    def test_most_movers_follow_ephemeris_and_missing_epochs_are_extrapolated(self) -> None:
        r1 = offset_arcsec(RA0, DEC0, 0.0, 0.0)
        r2 = offset_arcsec(RA0, DEC0, 0.0, 6.0)
        rows = [
            {
                "object_name": "Comet",
                "epoch_id": "pass_1",
                "ra": r1[0],
                "dec": r1[1],
                "x": 0,
                "y": 0,
                "v_mag": 11.0,
            },
            {
                "object_name": "Comet",
                "epoch_id": "pass_2",
                "ra": r2[0],
                "dec": r2[1],
                "x": 0,
                "y": 0,
                "v_mag": 11.0,
            },
        ]
        (obj,) = build([], [], rows)
        p1, p2 = obj["epoch_positions"]
        self.assertAlmostEqual((p2["dec"] - p1["dec"]) * 3600.0, 6.0, places=3)
        self.assertEqual(obj["catalog"], "most")
        self.assertEqual(obj["object_type"], "solar_system")
        self.assertAlmostEqual(obj["pmdec_mas_yr"] / 1000.0, 6.0 / BASELINE_YR, delta=0.01)
        # single-epoch ephemeris: held constant rather than dropped
        (single,) = build([], [], rows[:1])
        self.assertEqual(len(single["epoch_positions"]), 2)
        self.assertEqual(single["epoch_positions"][0]["x"], single["epoch_positions"][1]["x"])

    def test_default_checked_notable_movers_only_and_capped_at_eight(self) -> None:
        rows = [
            gaia(f"S{i}", d_east=-100.0 + i * 12.0, pmra=20.0, g=16.0 + i * 0.1) for i in range(6)
        ]  # stationary-ish field stars (0.02 arcsec/yr)
        mover = gaia("FAST", d_east=40.0, pmdec=150.0)  # exactly 0.15 arcsec/yr
        slow = gaia("SLOW", d_east=50.0, pmdec=149.0)  # just below 0.15
        bd = wise("BD", d_north=40.0, color=0.8)
        ceres = [
            {
                "object_name": "Ceres",
                "epoch_id": e["epoch_id"],
                "ra": RA0,
                "dec": DEC0 + 0.01,
                "x": 0,
                "y": 0,
                "v_mag": 8.0,
            }
            for e in EPOCHS
        ]
        objs = build(rows + [mover, slow], [bd], ceres)
        by_id = {o["object_id"]: o for o in objs}
        self.assertTrue(by_id["gaia:FAST"]["default_checked"])
        self.assertFalse(by_id["gaia:SLOW"]["default_checked"])
        self.assertTrue(by_id["wise:BD"]["default_checked"])
        self.assertTrue(by_id["most:Ceres"]["default_checked"])
        for i in range(6):
            self.assertFalse(by_id[f"gaia:S{i}"]["default_checked"])
        checked = [o for o in objs if o["default_checked"]]
        self.assertEqual(len(checked), 3)
        # checked objects are listed first
        self.assertTrue(all(o["default_checked"] for o in objs[: len(checked)]))

        many = [gaia(f"M{i}", d_east=-100.0 + i * 12.0, pmdec=200.0 + i * 10.0) for i in range(12)]
        capped = build(many)
        self.assertEqual(sum(o["default_checked"] for o in capped), 8)
        # the fastest movers win the 8 slots
        chosen = {o["object_id"] for o in capped if o["default_checked"]}
        self.assertEqual(chosen, {f"gaia:M{i}" for i in range(4, 12)})

    def test_central_target_is_always_checked_and_ranked_first(self) -> None:
        field = [gaia(f"F{i}", d_east=-100.0 + i * 12.0, pmdec=400.0) for i in range(10)]
        center = {**gaia("C", pmra=1.0, pmdec=1.0, g=12.0), "object_id": "gaia:center"}  # ~0 PM
        objs = build(field + [center], central_object_id="gaia:center")
        self.assertEqual(objs[0]["object_id"], "gaia:center")
        self.assertTrue(objs[0]["default_checked"])
        self.assertEqual(sum(o["default_checked"] for o in objs), 8)
        # without a central id the stationary star is not notable
        plain = {o["object_id"]: o for o in build(field + [center])}
        self.assertFalse(plain["gaia:center"]["default_checked"])

    def test_empty_inputs_and_epoch_validation(self) -> None:
        self.assertEqual(build(), [])
        with self.assertRaises(ValueError):
            build_known_objects([gaia("G")], [], [], WCS, [])


if __name__ == "__main__":
    unittest.main()
