import shutil
import tempfile

from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import override_settings
from rest_framework.test import APITestCase

from .models import ExperienceItem, ModelAsset, Project, TargetImage, User

MEDIA = tempfile.mkdtemp(prefix="arstudio-test-media-")
PNG = (
    b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15\xc4\x89"
    b"\x00\x00\x00\rIDATx\x9cc\xf8\xff\xff?\x00\x05\xfe\x02\xfe\xa7V\x81\xe2\x00\x00\x00\x00IEND\xaeB`\x82"
)


@override_settings(MEDIA_ROOT=MEDIA)
class ProjectTypesTests(APITestCase):
    @classmethod
    def tearDownClass(cls):
        super().tearDownClass()
        shutil.rmtree(MEDIA, ignore_errors=True)

    def setUp(self):
        self.user = User.objects.create_user(username="u", email="u@example.com", password="pw-12345678")
        self.client.force_authenticate(self.user)

    def make_project(self, project_type, **extra):
        res = self.client.post(
            "/api/projects/", {"name": f"{project_type} p", "project_type": project_type, **extra}, format="json"
        )
        self.assertEqual(res.status_code, 201, res.data)
        return Project.objects.get(id=res.data["id"])

    def make_asset(self, project, fmt="glb"):
        return ModelAsset.objects.create(
            project=project, name=f"a.{fmt}", format=fmt,
            model_file=SimpleUploadedFile(f"a.{fmt}", b"data"),
        )

    def make_experience(self, project):
        res = self.client.post("/api/experiences/", {"project": str(project.id), "name": "Main"}, format="json")
        self.assertEqual(res.status_code, 201, res.data)
        return res.data["id"]

    def test_wizard_type_and_settings_are_saved_and_type_is_fixed(self):
        project = self.make_project("face", type_settings={"default_point": "nose", "occlusion": True, "junk": 1})
        self.assertEqual(project.type_settings["default_point"], "nose")
        self.assertTrue(project.type_settings["occlusion"])
        self.assertNotIn("junk", project.type_settings)
        res = self.client.patch(f"/api/projects/{project.id}/", {"project_type": "object"}, format="json")
        self.assertEqual(res.status_code, 400)

    def test_face_item_needs_point_not_target(self):
        project = self.make_project("face")
        exp = self.make_experience(project)
        asset = self.make_asset(project)
        bad = self.client.post("/api/items/", {"experience": exp, "model_asset": str(asset.id)}, format="json")
        self.assertEqual(bad.status_code, 400)
        ok = self.client.post(
            "/api/items/", {"experience": exp, "model_asset": str(asset.id), "anchor_value": "eyes"}, format="json"
        )
        self.assertEqual(ok.status_code, 201, ok.data)
        item = ExperienceItem.objects.get(id=ok.data["id"])
        self.assertEqual((item.anchor_type, item.anchor_value, item.target_image), ("face", "eyes", None))

    def test_face_mask_needs_image_and_marker_settings_saved(self):
        project = self.make_project("face", type_settings={"show_mesh": True, "show_points": 1})
        self.assertTrue(project.type_settings["show_mesh"] and project.type_settings["show_points"])
        self.assertFalse(project.type_settings["show_contours"])
        exp = self.make_experience(project)
        model = self.make_asset(project)
        bad = self.client.post(
            "/api/items/", {"experience": exp, "model_asset": str(model.id), "anchor_value": "mesh"}, format="json"
        )
        self.assertEqual(bad.status_code, 400)
        image = self.make_asset(project, "png")
        ok = self.client.post(
            "/api/items/", {"experience": exp, "model_asset": str(image.id), "anchor_value": "mesh"}, format="json"
        )
        self.assertEqual(ok.status_code, 201, ok.data)

    def test_object_item_label_validated(self):
        project = self.make_project("object")
        exp = self.make_experience(project)
        asset = self.make_asset(project)
        bad = self.client.post(
            "/api/items/", {"experience": exp, "model_asset": str(asset.id), "anchor_value": "dragon"}, format="json"
        )
        self.assertEqual(bad.status_code, 400)

    def test_image_item_still_needs_target_and_sounds_are_not_placeable(self):
        project = self.make_project("game")
        exp = self.make_experience(project)
        sound = self.make_asset(project, "mp3")
        target = TargetImage.objects.create(
            project=project, name="t", image=SimpleUploadedFile("t.png", PNG, content_type="image/png")
        )
        no_target = self.client.post("/api/items/", {"experience": exp, "model_asset": str(self.make_asset(project).id)}, format="json")
        self.assertEqual(no_target.status_code, 400)
        sound_item = self.client.post(
            "/api/items/", {"experience": exp, "model_asset": str(sound.id), "target_image": str(target.id)}, format="json"
        )
        self.assertEqual(sound_item.status_code, 400)

    def test_game_logic_validation(self):
        project = self.make_project("game")
        good = {
            "variables": [{"name": "lives", "initial": 3}],
            "rules": [{
                "event": {"type": "tap", "item": "abc"},
                "conditions": [{"type": "var", "var": "lives", "op": ">", "value": 0}],
                "actions": [{"action": "change_var", "var": "lives", "value": -1}, {"action": "win"}],
            }],
            "script_enabled": True,
            "script": "on('start', () => message('hi'))",
        }
        res = self.client.patch(f"/api/projects/{project.id}/", {"game_logic": good}, format="json")
        self.assertEqual(res.status_code, 200, res.data)
        project.refresh_from_db()
        self.assertTrue(project.game_logic["script_enabled"])
        for bad in [
            {"rules": [{"event": {"type": "explode"}, "actions": [{"action": "win"}]}]},
            {"rules": [{"event": {"type": "game_start"}, "actions": [{"action": "set_var", "var": "nope", "value": 1}]}]},
            {"rules": [{"event": {"type": "game_start"}, "actions": []}]},
            {"variables": [{"name": "1bad"}]},
            {"script": "x" * 20_001},
        ]:
            res = self.client.patch(f"/api/projects/{project.id}/", {"game_logic": bad}, format="json")
            self.assertEqual(res.status_code, 400, bad)

    def test_publish_payload_for_face_and_game(self):
        project = self.make_project("face", type_settings={"default_point": "eyes"})
        exp = self.make_experience(project)
        asset = self.make_asset(project)
        self.client.post(
            "/api/items/", {"experience": exp, "model_asset": str(asset.id), "anchor_value": "head_top"}, format="json"
        )
        pub = self.client.post(f"/api/projects/{project.id}/publish/", {"scene_ids": [exp]}, format="json")
        self.assertIn(pub.status_code, (200, 201), pub.data)
        self.client.force_authenticate(None)
        data = self.client.get(f"/api/public/{pub.data['published_experience_id']}/").data
        self.assertEqual(data["project_type"], "face")
        self.assertEqual(data["items"][0]["anchor"], {"type": "face", "value": "head_top"})
        self.assertIsNone(data["items"][0]["target"])
        self.assertIsNone(data["game"])

        self.client.force_authenticate(self.user)
        game = self.make_project("game", game_logic={
            "rules": [{"event": {"type": "game_start"}, "actions": [{"action": "show_message", "text": "Go"}]}]
        })
        self.make_asset(game, "mp3")
        target = TargetImage.objects.create(
            project=game, name="t", image=SimpleUploadedFile("t.png", PNG, content_type="image/png")
        )
        gexp = self.make_experience(game)
        self.client.post(
            "/api/items/",
            {"experience": gexp, "model_asset": str(self.make_asset(game).id), "target_image": str(target.id)},
            format="json",
        )
        pub = self.client.post(f"/api/projects/{game.id}/publish/", {"scene_ids": [gexp]}, format="json")
        self.assertIn(pub.status_code, (200, 201), pub.data)
        data = self.client.get(f"/api/public/{pub.data['published_experience_id']}/").data
        self.assertTrue(data["game"]["enabled"])
        self.assertEqual(data["game"]["logic"]["rules"][0]["actions"][0]["text"], "Go")
        self.assertEqual(len(data["sounds"]), 1)


def _textured_png(width=640, height=480, seed=7):
    """A detailed random-rectangles image that ORB can track."""
    import cv2
    import numpy as np

    rng = np.random.default_rng(seed)
    img = np.full((height, width, 3), 255, np.uint8)
    for _ in range(260):
        x, y = int(rng.integers(0, width)), int(rng.integers(0, height))
        w, h = int(rng.integers(8, 70)), int(rng.integers(8, 70))
        color = tuple(int(c) for c in rng.integers(0, 255, 3))
        cv2.rectangle(img, (x, y), (x + w, y + h), color, -1)
    ok, buf = cv2.imencode(".png", img)
    assert ok
    return buf.tobytes()


@override_settings(MEDIA_ROOT=MEDIA)
class TargetCompilerTests(APITestCase):
    def setUp(self):
        self.user = User.objects.create_user(username="c", email="c@example.com", password="pw-12345678")
        self.client.force_authenticate(self.user)
        res = self.client.post("/api/projects/", {"name": "Cards", "project_type": "image_ar"}, format="json")
        self.project = Project.objects.get(id=res.data["id"])

    def add_target(self, name, data):
        return TargetImage.objects.create(
            project=self.project, name=name, image=SimpleUploadedFile(f"{name}.png", data)
        )

    def test_compile_builds_one_bundle_with_browser_compatible_entries(self):
        import base64
        import json

        good = self.add_target("good", _textured_png())
        blank = self.add_target("blank", PNG)
        status = self.client.get(f"/api/projects/{self.project.id}/compile-targets/").data
        self.assertTrue(status["stale"])

        res = self.client.post(f"/api/projects/{self.project.id}/compile-targets/")
        self.assertEqual(res.status_code, 200, res.data)
        self.assertFalse(res.data["stale"])
        self.assertEqual((res.data["total"], res.data["compiled"]), (2, 1))

        good.refresh_from_db()
        blank.refresh_from_db()
        self.assertEqual(good.tracking_data["status"], "ready")
        self.assertEqual(good.tracking_data["index"], 0)
        self.assertGreaterEqual(good.tracking_data["rating"], 3)
        self.assertEqual(blank.tracking_data["status"], "failed")
        self.assertIsNone(blank.tracking_data["index"])

        self.project.refresh_from_db()
        with self.project.compiled_targets.open("rb") as fh:
            bundle = json.loads(fh.read())
        self.assertEqual((bundle["format"], bundle["version"]), ("ar-studio-targets", 1))
        [entry] = bundle["targets"]
        self.assertEqual(entry["id"], str(good.id))
        self.assertEqual((entry["width"], entry["height"]), (640, 480))
        self.assertEqual(len(base64.b64decode(entry["descriptors"])), entry["count"] * 32)
        self.assertEqual(len(base64.b64decode(entry["keypoints"])), entry["count"] * 8)

        # Adding a target makes the bundle stale again.
        self.add_target("another", _textured_png(seed=3))
        res = self.client.get(f"/api/projects/{self.project.id}/")
        self.assertTrue(res.data["targets_compile"]["stale"])

    def test_large_targets_are_compiled_at_max_edge(self):
        target = self.add_target("big", _textured_png(2160, 1080))
        self.client.post(f"/api/projects/{self.project.id}/compile-targets/")
        target.refresh_from_db()
        self.assertEqual((target.tracking_data["width"], target.tracking_data["height"]), (1080, 540))
        self.assertEqual(target.tracking_data["source_width"], 2160)

    def test_publish_compiles_stale_targets_and_ships_bundle(self):
        target = self.add_target("good", _textured_png())
        asset = ModelAsset.objects.create(
            project=self.project, name="a.glb", format="glb",
            model_file=SimpleUploadedFile("a.glb", b"data"),
        )
        exp = self.client.post(
            "/api/experiences/", {"project": str(self.project.id), "name": "Main"}, format="json"
        ).data["id"]
        ExperienceItem.objects.create(
            experience_id=exp, target_image=target, model_asset=asset, name="i"
        )
        res = self.client.post(
            f"/api/projects/{self.project.id}/publish/", {"scene_ids": [exp]}, format="json"
        )
        self.assertIn(res.status_code, (200, 201), res.data)
        public = self.client.get(f"/api/public/{res.data['published_experience_id']}/").data
        self.assertEqual(public["compiled_targets"]["count"], 1)
        self.assertIn("/media/compiled_targets/", public["compiled_targets"]["url"])
        self.assertEqual(public["items"][0]["target"]["index"], 0)


class TargetQualityTests(APITestCase):
    def _write(self, img):
        import cv2

        fd, path = tempfile.mkstemp(suffix=".png", dir=MEDIA)
        import os

        os.close(fd)
        cv2.imwrite(path, img)
        return path

    def test_repeated_texture_rates_low_and_detailed_image_rates_high(self):
        import cv2
        import numpy as np

        from .service.target_compiler import CONFIG, compile_target

        tile = np.full((60, 60, 3), 255, np.uint8)
        cv2.rectangle(tile, (8, 8), (30, 30), (20, 20, 20), -1)
        cv2.circle(tile, (44, 44), 9, (180, 40, 40), -1)
        tiles = np.tile(tile, (15, 20, 1))
        bad = compile_target(self._write(tiles))["quality"]
        self.assertLessEqual(bad["rating"], 2)
        self.assertLess(bad["uniqueness"], 0.3)

        good_img = cv2.imdecode(np.frombuffer(_textured_png(1200, 900), np.uint8), cv2.IMREAD_COLOR)
        good = compile_target(self._write(good_img))
        q = good["quality"]
        self.assertGreaterEqual(q["rating"], 4)
        self.assertLessEqual(q["feature_count"], CONFIG["budget"])
        self.assertEqual(len(good["points"]), len(good["descriptors"]))
        self.assertGreaterEqual(q["scale_levels"], 4)


class ExperienceGameRemovedTests(APITestCase):
    def test_ar_experience_never_publishes_game_rules(self):
        from .serializer import game_payload

        user = User.objects.create_user(username="g", email="g@example.com", password="pw-12345678")
        project = Project.objects.create(
            user=user, name="Exp", project_type="image_ar",
            game_settings={"enabled": True, "goal": "score", "target_score": 10, "time_limit": 30},
        )
        self.assertIsNone(game_payload(project))
        game = Project.objects.create(user=user, name="G", project_type="game")
        self.assertTrue(game_payload(game)["enabled"])


@override_settings(MEDIA_ROOT=MEDIA)
class ScoreActionRemovedTests(APITestCase):
    def setUp(self):
        self.user = User.objects.create_user(username="s", email="s@example.com", password="pw-12345678")
        self.client.force_authenticate(self.user)

    def _item(self, project_type):
        project = Project.objects.create(user=self.user, name=project_type, project_type=project_type)
        exp = self.client.post("/api/experiences/", {"project": str(project.id), "name": "M"}, format="json").data["id"]
        target = TargetImage.objects.create(project=project, name="t", image=SimpleUploadedFile("t.png", PNG))
        asset = ModelAsset.objects.create(project=project, name="a.glb", format="glb",
                                          model_file=SimpleUploadedFile("a.glb", b"data"))
        return ExperienceItem.objects.create(experience_id=exp, target_image=target, model_asset=asset, name="i")

    def test_add_score_is_dropped_outside_game_projects(self):
        from .serializer import _item_payload

        rules = {"start_hidden": False, "on_tap": [{"action": "add_score", "value": 5}, {"action": "hide_self"}]}
        item = self._item("image_ar")
        res = self.client.patch(f"/api/items/{item.id}/", {"behaviors": rules}, format="json")
        self.assertEqual(res.status_code, 200, res.data)
        self.assertEqual([r["action"] for r in res.data["behaviors"]["on_tap"]], ["hide_self"])

        # Rules saved before this change are also removed from published payloads.
        ExperienceItem.objects.filter(id=item.id).update(behaviors=rules)
        item.refresh_from_db()
        self.assertEqual(
            [r["action"] for r in _item_payload(_Req(), item)["behaviors"]["on_tap"]],
            ["hide_self"],
        )

        game_item = self._item("game")
        res = self.client.patch(f"/api/items/{game_item.id}/", {"behaviors": rules}, format="json")
        self.assertEqual(len(res.data["behaviors"]["on_tap"]), 2)


class _Req:
    def build_absolute_uri(self, url):
        return url


@override_settings(MEDIA_ROOT=MEDIA)
class AssetOptimizeTests(APITestCase):
    def test_optimized_upload_flag_size_and_replacement_format(self):
        user = User.objects.create_user(username="o", email="o@example.com", password="pw-12345678")
        self.client.force_authenticate(user)
        project = Project.objects.create(user=user, name="P", project_type="image_ar")
        res = self.client.post("/api/assets/", {
            "project": str(project.id), "name": "drone", "format": "glb", "optimized": "true",
            "model_file": SimpleUploadedFile("drone.glb", b"x" * 1234),
        }, format="multipart")
        self.assertEqual(res.status_code, 201, res.data)
        self.assertTrue(res.data["optimized"])
        self.assertEqual(res.data["file_size"], 1234)

        # Replacing the file (studio "Optimize" button) must keep the format.
        bad = self.client.patch(f"/api/assets/{res.data['id']}/", {
            "model_file": SimpleUploadedFile("drone.png", PNG),
        }, format="multipart")
        self.assertEqual(bad.status_code, 400)
        ok = self.client.patch(f"/api/assets/{res.data['id']}/", {
            "model_file": SimpleUploadedFile("drone.glb", b"y" * 99), "optimized": "true",
        }, format="multipart")
        self.assertEqual(ok.status_code, 200, ok.data)
        self.assertEqual(ok.data["file_size"], 99)


@override_settings(MEDIA_ROOT=MEDIA)
class CustomModelUploadTests(APITestCase):
    """The marker-less "custom 3D model" mode and 3D upload validation."""

    def setUp(self):
        self.user = User.objects.create_user(
            username="modeler", email="modeler@example.com", password="pw-12345678"
        )
        self.client.force_authenticate(self.user)

    def test_user_model_publish_and_live_available_models(self):
        res = self.client.post(
            "/api/projects/",
            {
                "name": "Custom model",
                "project_type": "image_ar",
                "type_settings": {"mode": "user_model"},
            },
            format="json",
        )
        self.assertEqual(res.status_code, 201, res.data)
        project = Project.objects.get(id=res.data["id"])
        self.assertEqual(project.type_settings["mode"], "user_model")

        upload = self.client.post(
            "/api/assets/",
            {
                "project": str(project.id),
                "name": "robot",
                "format": "glb",
                "model_file": SimpleUploadedFile("robot.glb", b"glb-data"),
            },
            format="multipart",
        )
        self.assertEqual(upload.status_code, 201, upload.data)

        exp = self.client.post(
            "/api/experiences/", {"project": str(project.id), "name": "Floating"}, format="json"
        )
        self.assertEqual(exp.status_code, 201, exp.data)

        # A user-model scene is allowed to publish with no placed items.
        pub = self.client.post(
            f"/api/projects/{project.id}/publish/",
            {"scene_ids": [exp.data["id"]]},
            format="json",
        )
        self.assertIn(pub.status_code, (200, 201), pub.data)

        self.client.force_authenticate(None)
        data = self.client.get(f"/api/public/{pub.data['published_experience_id']}/").data
        self.assertEqual(data["mode"], "user_model")
        self.assertEqual(data["project_id"], str(project.id))
        self.assertEqual(data["items"], [])
        self.assertEqual(len(data["available_models"]), 1)
        model = data["available_models"][0]
        self.assertEqual(model["name"], "robot")
        self.assertEqual(model["format"], "glb")
        self.assertEqual(model["file_size"], 8)
        self.assertTrue(model["url"].endswith(".glb"))

        # Uploaded after publishing: appears immediately (no republish needed).
        self.client.force_authenticate(self.user)
        second = self.client.post(
            "/api/assets/",
            {
                "project": str(project.id),
                "name": "planet",
                "format": "glb",
                "model_file": SimpleUploadedFile("planet.glb", b"second"),
            },
            format="multipart",
        )
        self.assertEqual(second.status_code, 201, second.data)
        self.client.force_authenticate(None)
        data = self.client.get(f"/api/public/{pub.data['published_experience_id']}/").data
        self.assertEqual(
            [m["name"] for m in data["available_models"]], ["robot", "planet"]
        )

    def test_model_upload_rejects_wrong_extension_and_non_3d_content(self):
        project = Project.objects.create(
            user=self.user,
            name="P",
            project_type="image_ar",
            type_settings={"mode": "user_model"},
        )
        wrong_ext = self.client.post(
            "/api/assets/",
            {
                "project": str(project.id),
                "name": "fake",
                "format": "glb",
                "model_file": SimpleUploadedFile("fake.png", PNG, content_type="image/png"),
            },
            format="multipart",
        )
        self.assertEqual(wrong_ext.status_code, 400, wrong_ext.data)

        image_bytes = self.client.post(
            "/api/assets/",
            {
                "project": str(project.id),
                "name": "fake",
                "format": "glb",
                "model_file": SimpleUploadedFile("fake.glb", PNG, content_type="image/png"),
            },
            format="multipart",
        )
        self.assertEqual(image_bytes.status_code, 400, image_bytes.data)
        self.assertIn("not a 3D model", str(image_bytes.data))

    def test_model_upload_enforces_size_limit(self):
        from unittest.mock import patch

        project = Project.objects.create(
            user=self.user,
            name="P",
            project_type="image_ar",
            type_settings={"mode": "user_model"},
        )
        with patch("api.serializer.MAX_MODEL_BYTES", 10):
            too_big = self.client.post(
                "/api/assets/",
                {
                    "project": str(project.id),
                    "name": "big",
                    "format": "glb",
                    "model_file": SimpleUploadedFile(
                        "big.glb", b"x" * 11, content_type="model/gltf-binary"
                    ),
                },
                format="multipart",
            )
        self.assertEqual(too_big.status_code, 400, too_big.data)
        self.assertIn("MB or smaller", str(too_big.data))


@override_settings(MEDIA_ROOT=MEDIA)
class AdminSecurityAndRBACTests(APITestCase):
    @classmethod
    def tearDownClass(cls):
        super().tearDownClass()
        shutil.rmtree(MEDIA, ignore_errors=True)

    def setUp(self):
        from .models import Organization, OrganizationMember

        self.customer = User.objects.create_user(
            username="cust", email="cust@example.com", password="pw", role="customer"
        )
        self.super_admin = User.objects.create_user(
            username="super", email="super@example.com", password="pw", role="super_admin"
        )
        self.finance_admin = User.objects.create_user(
            username="fin", email="fin@example.com", password="pw", role="finance_admin"
        )
        self.content_admin = User.objects.create_user(
            username="content", email="content@example.com", password="pw", role="content_admin"
        )
        self.support_admin = User.objects.create_user(
            username="support", email="support@example.com", password="pw", role="support_admin"
        )

        # Organization & Projects
        self.org1 = Organization.objects.create(name="Org One", owner=self.customer)
        self.org2 = Organization.objects.create(name="Org Two", owner=self.super_admin)
        self.project1 = Project.objects.create(user=self.customer, organization=self.org1, name="P1")
        self.project2 = Project.objects.create(user=self.super_admin, organization=self.org2, name="P2")
        self.asset1 = ModelAsset.objects.create(
            project=self.project1, name="Asset 1", format="glb",
            approval_status="pending", is_shared=False,
            model_file=SimpleUploadedFile("a1.glb", b"test")
        )

    def test_unauthenticated_blocked_from_all_admin_endpoints(self):
        self.client.logout()
        endpoints = [
            ("/api/v1/admin/overview/", "get"),
            ("/api/v1/admin/users/", "get"),
            ("/api/v1/admin/organizations/", "get"),
            ("/api/v1/admin/projects/", "get"),
            ("/api/v1/admin/assets/moderation/", "get"),
        ]
        for url, method in endpoints:
            res = getattr(self.client, method)(url)
            self.assertIn(res.status_code, [401, 403], f"{url} allowed unauthenticated access")

    def test_customer_forbidden_from_admin_endpoints(self):
        self.client.force_authenticate(self.customer)
        endpoints = [
            ("/api/v1/admin/overview/", "get"),
            ("/api/v1/admin/users/", "get"),
            (f"/api/v1/admin/users/{self.customer.id}/role/", "patch"),
            ("/api/v1/admin/organizations/", "get"),
            ("/api/v1/admin/projects/", "get"),
            ("/api/v1/admin/assets/moderation/", "get"),
        ]
        for url, method in endpoints:
            res = getattr(self.client, method)(url, data={}, format="json")
            self.assertEqual(res.status_code, 403, f"{url} did not return 403 for customer")

    def test_content_admin_can_moderate_assets_but_not_manage_users_or_orgs(self):
        self.client.force_authenticate(self.content_admin)
        # Blocked from users and organizations
        res_users = self.client.get("/api/v1/admin/users/")
        self.assertEqual(res_users.status_code, 403)
        res_orgs = self.client.get("/api/v1/admin/organizations/")
        self.assertEqual(res_orgs.status_code, 403)

        # Allowed to view and moderate assets
        res_assets = self.client.get("/api/v1/admin/assets/moderation/?status=pending")
        self.assertEqual(res_assets.status_code, 200)
        self.assertEqual(len(res_assets.data["assets"]), 1)

        # Approve asset
        approve_res = self.client.post(
            "/api/v1/admin/assets/moderation/",
            {"asset_id": str(self.asset1.id), "action": "approve"},
            format="json"
        )
        self.assertEqual(approve_res.status_code, 200)
        self.asset1.refresh_from_db()
        self.assertEqual(self.asset1.approval_status, "approved")
        self.assertTrue(self.asset1.is_shared)

    def test_only_super_admin_can_update_roles_and_suspend_users(self):
        # Finance admin tries to update role -> 403
        self.client.force_authenticate(self.finance_admin)
        res_fin = self.client.patch(
            f"/api/v1/admin/users/{self.customer.id}/role/",
            {"role": "super_admin"},
            format="json"
        )
        self.assertEqual(res_fin.status_code, 403)

        # Super admin updates role -> 200
        self.client.force_authenticate(self.super_admin)
        res_sup = self.client.patch(
            f"/api/v1/admin/users/{self.customer.id}/role/",
            {"role": "finance_admin", "is_active": False},
            format="json"
        )
        self.assertEqual(res_sup.status_code, 200)
        self.customer.refresh_from_db()
        self.assertEqual(self.customer.role, "finance_admin")
        self.assertFalse(self.customer.is_active)

    def test_organization_data_isolation_in_standard_api(self):
        # Customer cannot see projects belonging to other users
        self.client.force_authenticate(self.customer)
        res = self.client.get("/api/projects/")
        self.assertEqual(res.status_code, 200)
        project_ids = [p["id"] for p in res.data]
        self.assertIn(str(self.project1.id), project_ids)
        self.assertNotIn(str(self.project2.id), project_ids)

