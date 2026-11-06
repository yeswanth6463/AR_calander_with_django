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
