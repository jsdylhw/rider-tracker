from __future__ import annotations

from integrations.garmin import activity_base_name, existing_fit_paths, safe_filename, save_original_as_fit


def test_safe_filename_removes_path_unsafe_characters():
    assert safe_filename('a/b:c*"x"\n') == "a_b_c_x_"


def test_activity_base_name_uses_local_start_name_and_id():
    activity = {
        "activityId": 123,
        "activityName": "青浦区 公路骑行",
        "startTimeLocal": "2026-05-18 08:36:17",
    }

    assert activity_base_name(activity) == "2026-05-18 08_36_17_青浦区 公路骑行_123"


def test_existing_fit_paths_matches_saved_activity_prefix(tmp_path):
    activity = {
        "activityId": 123,
        "activityName": "Ride",
        "startTimeLocal": "2026-05-18",
    }
    fit_path = tmp_path / "2026-05-18_Ride_123.fit"
    fit_path.write_bytes(b"fit")
    (tmp_path / "other.fit").write_bytes(b"fit")

    assert existing_fit_paths(tmp_path, activity) == [fit_path]


def test_save_original_writes_fit_atomically(tmp_path):
    activity = {"activityId": 123, "activityName": "Ride", "startTimeLocal": "2026-05-18"}

    paths = save_original_as_fit(b"complete-fit", tmp_path, activity)

    assert len(paths) == 1
    assert paths[0].read_bytes() == b"complete-fit"
    assert not list(tmp_path.glob("*.part"))
