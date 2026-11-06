
from rest_framework import serializers

from .anchors import (
    ANCHOR_FOR_PROJECT,
    AUDIO_FORMATS,
    FACE_POINTS,
    IMAGE_FORMATS,
    OBJECT_LABELS,
    PLACEABLE_FORMATS,
    clean_type_settings,
)
from .game_logic import clean_game_logic
from .models import Project, ProjectPublication, TargetImage, ModelAsset, ARExperience, ExperienceItem


GAME_GOALS = {"none", "score", "collect_all"}
MAX_GAME_SECONDS = 3600


def _clean_text(value, limit=200):
    return str(value or "").strip()[:limit]


def clean_game_settings(value):
    """Validate/normalise Project.game_settings."""
    if value in (None, "", {}):
        return None
    if not isinstance(value, dict):
        raise serializers.ValidationError("Game settings must be an object.")
    goal = value.get("goal") or "none"
    if goal not in GAME_GOALS:
        raise serializers.ValidationError({"goal": "Unknown game goal."})
    try:
        target_score = float(value.get("target_score") or 0)
        time_limit = int(float(value.get("time_limit") or 0))
    except (TypeError, ValueError):
        raise serializers.ValidationError("Score and time limit must be numbers.")
    if goal == "score" and target_score <= 0:
        raise serializers.ValidationError({"target_score": "Target score must be greater than zero."})
    if not 0 <= time_limit <= MAX_GAME_SECONDS:
        raise serializers.ValidationError(
            {"time_limit": f"Time limit must be between 0 and {MAX_GAME_SECONDS} seconds."}
        )
    if abs(target_score) > 1_000_000:
        raise serializers.ValidationError({"target_score": "Target score is too large."})
    return {
        "enabled": bool(value.get("enabled")),
        "goal": goal,
        "target_score": target_score,
        "time_limit": time_limit,
        "intro": _clean_text(value.get("intro")),
        "win_message": _clean_text(value.get("win_message")),
        "lose_message": _clean_text(value.get("lose_message")),
    }


def game_payload(project):
    """Game settings as published, or None when the game is switched off.

    AR Game projects are always games; their rule-builder logic rides along.
    """
    settings = getattr(project, "game_settings", None)
    is_game = getattr(project, "project_type", "") == "game"
    if not (isinstance(settings, dict) and settings.get("enabled")):
        if not is_game:
            return None
        settings = {"enabled": True, "goal": "none", "target_score": 0, "time_limit": 0,
                    "intro": "", "win_message": "", "lose_message": ""}
    payload = dict(settings, enabled=True)
    if is_game and isinstance(project.game_logic, dict):
        payload["logic"] = project.game_logic
    return payload


def project_extras(request, project):
    """Project-wide data the viewer needs besides scene items."""
    sounds = [
        {
            "id": str(asset.id),
            "name": asset.name,
            "url": request.build_absolute_uri(asset.model_file.url),
        }
        for asset in project.model_assets.filter(format__in=AUDIO_FORMATS, is_active=True)
    ]
    return {
        "project_type": project.project_type,
        "type_settings": project.type_settings or {},
        "sounds": sounds,
    }


class ProjectSerializer(serializers.ModelSerializer):
    publication_slug = serializers.SerializerMethodField()

    class Meta:
        model = Project
        fields = [
            "id", "name", "slug", "description",
            "is_active", "project_type", "type_settings", "game_logic", "game_settings",
            "created_at", "updated_at",
            "publication_slug",
        ]
        read_only_fields = ["id", "slug", "created_at", "updated_at", "publication_slug"]

    def validate_game_settings(self, value):
        return clean_game_settings(value)

    def validate_game_logic(self, value):
        return clean_game_logic(value)

    def validate_project_type(self, value):
        if self.instance is not None and value != self.instance.project_type:
            raise serializers.ValidationError("The project type cannot be changed after creation.")
        return value

    def validate(self, attrs):
        attrs = super().validate(attrs)
        project_type = attrs.get("project_type", getattr(self.instance, "project_type", "image_ar"))
        if "type_settings" in attrs or self.instance is None:
            attrs["type_settings"] = clean_type_settings(project_type, attrs.get("type_settings")) or None
        return attrs

    def get_publication_slug(self, obj):
        try:
            published = obj.publication
        except ProjectPublication.DoesNotExist:
            return None
        if published and published.is_active:
            return published.slug or str(published.public_id)
        return None


class TargetImageSerializer(serializers.ModelSerializer):
    class Meta:
        model = TargetImage
        fields = [
            "id", "project", "name", "image", "target_width",
            "is_active", "tracking_data", "created_at",
        ]
        read_only_fields = ["id", "tracking_data", "created_at", "is_active"]

    def validate_project(self, project):
        request = self.context.get("request")
        if request and project.user_id != request.user.id:
            raise serializers.ValidationError(
                "You do not own this project."
            )
        return project

    def validate_target_width(self, value):
        if value <= 0:
            raise serializers.ValidationError(
                "Target width must be greater than zero."
            )
        return value


class ModelAssetSerializer(serializers.ModelSerializer):
    class Meta:
        model = ModelAsset
        fields = [
            "id", "project", "name", "model_file", "format",
            "is_active", "created_at",
        ]
        read_only_fields = ["id", "created_at", "is_active"]

    def validate_project(self, project):
        request = self.context.get("request")
        if request and project.user_id != request.user.id:
            raise serializers.ValidationError(
                "You do not own this project."
            )
        return project

    def validate(self, attrs):
        attrs = super().validate(attrs)
        uploaded_file = attrs.get("model_file")
        asset_format = attrs.get("format")
        if uploaded_file and asset_format:
            extension = uploaded_file.name.rsplit(".", 1)[-1].lower()
            if extension != asset_format:
                raise serializers.ValidationError({
                    "format": "Asset format must match the uploaded file extension."
                })
        return attrs


BEHAVIOR_ACTIONS = {
    "toggle_animation": None,
    "play_animation": None,
    "hide_self": None,
    "show_item": "item",
    "hide_item": "item",
    "toggle_item": "item",
    "add_score": "number",
    "play_sound": "sound",
    "show_message": "text",
}
BEHAVIOR_SOUNDS = {"pop", "chime", "success", "fail"}
MAX_TAP_ACTIONS = 10


def clean_behaviors(value):
    """Validate/normalise an ExperienceItem.behaviors payload."""
    if value in (None, "", {}):
        return None
    if not isinstance(value, dict):
        raise serializers.ValidationError("Behaviors must be an object.")
    on_tap = value.get("on_tap") or []
    if not isinstance(on_tap, list):
        raise serializers.ValidationError({"on_tap": "Must be a list."})
    if len(on_tap) > MAX_TAP_ACTIONS:
        raise serializers.ValidationError(
            {"on_tap": f"At most {MAX_TAP_ACTIONS} actions per tap."}
        )
    cleaned = []
    for index, rule in enumerate(on_tap):
        if not isinstance(rule, dict) or rule.get("action") not in BEHAVIOR_ACTIONS:
            raise serializers.ValidationError(
                {"on_tap": f"Action #{index + 1} is not a supported action."}
            )
        action = rule["action"]
        kind = BEHAVIOR_ACTIONS[action]
        raw = rule.get("value")
        if kind is None:
            cleaned.append({"action": action})
            continue
        if kind == "number":
            try:
                number = float(raw)
            except (TypeError, ValueError):
                raise serializers.ValidationError(
                    {"on_tap": f"Action #{index + 1} needs a number."}
                )
            if abs(number) > 1_000_000:
                raise serializers.ValidationError(
                    {"on_tap": f"Action #{index + 1}: number is too large."}
                )
            cleaned.append({"action": action, "value": number})
        elif kind == "sound":
            if raw not in BEHAVIOR_SOUNDS:
                raise serializers.ValidationError(
                    {"on_tap": f"Action #{index + 1}: unknown sound."}
                )
            cleaned.append({"action": action, "value": raw})
        else:  # item id / message text
            text = str(raw or "").strip()[:200]
            if not text:
                raise serializers.ValidationError(
                    {"on_tap": f"Action #{index + 1} needs a value."}
                )
            cleaned.append({"action": action, "value": text})
    return {"start_hidden": bool(value.get("start_hidden")), "on_tap": cleaned}


class ExperienceItemSerializer(serializers.ModelSerializer):
    class Meta:
        model = ExperienceItem
        fields = [
            "id", "experience", "target_image", "model_asset", "name",
            "order", "is_active",
            "position_x", "position_y", "position_z",
            "rotation_x", "rotation_y", "rotation_z",
            "scale", "scale_x", "scale_y", "scale_z",
            "animation", "behaviors", "anchor_type", "anchor_value",
            "created_at", "updated_at",
        ]
        read_only_fields = ["id", "order", "created_at", "updated_at"]

    def validate_behaviors(self, value):
        return clean_behaviors(value)

    def validate_experience(self, experience):
        request = self.context.get("request")
        if request and experience.project.user_id != request.user.id:
            raise serializers.ValidationError(
                "You do not own this experience."
            )
        return experience

    def validate(self, attrs):
        attrs = super().validate(attrs)

        if "scale" in attrs and not any(
            key in attrs for key in ("scale_x", "scale_y", "scale_z")
        ):
            attrs["scale_x"] = attrs["scale"]
            attrs["scale_y"] = attrs["scale"]
            attrs["scale_z"] = attrs["scale"]

        scales = {
            axis: attrs.get(axis, getattr(self.instance, axis, 1.0))
            for axis in ("scale_x", "scale_y", "scale_z")
        }
        if any(value <= 0 for value in scales.values()):
            raise serializers.ValidationError(
                {"scale": "Scale values must be greater than zero."}
            )

        attrs["scale"] = sum(scales.values()) / 3

        experience = attrs.get(
            "experience", getattr(self.instance, "experience", None)
        )
        project = experience.project if experience else None

        target = attrs.get(
            "target_image", getattr(self.instance, "target_image", None)
        )
        asset = attrs.get(
            "model_asset", getattr(self.instance, "model_asset", None)
        )

        if project and target and target.project_id != project.id:
            raise serializers.ValidationError(
                {"target_image": "Target must belong to this project."}
            )

        if project and asset and asset.project_id != project.id:
            raise serializers.ValidationError(
                {"model_asset": "Model must belong to this project."}
            )

        if asset and asset.format not in PLACEABLE_FORMATS:
            raise serializers.ValidationError(
                {"model_asset": "Sounds cannot be placed in a scene; use them in game rules."}
            )

        # Anchor follows the project type: image targets, face points or objects.
        anchor_type = ANCHOR_FOR_PROJECT.get(getattr(project, "project_type", "image_ar"), "image")
        attrs["anchor_type"] = anchor_type
        anchor_value = attrs.get("anchor_value", getattr(self.instance, "anchor_value", ""))
        if anchor_type == "image":
            if not target:
                raise serializers.ValidationError({"target_image": "Pick a target image."})
            attrs["anchor_value"] = ""
        else:
            attrs["target_image"] = None
            allowed = FACE_POINTS if anchor_type == "face" else OBJECT_LABELS
            if anchor_value not in allowed:
                raise serializers.ValidationError(
                    {"anchor_value": "Pick a face point." if anchor_type == "face" else "Pick an object to detect."}
                )
            if anchor_value == "mesh" and asset and asset.format not in IMAGE_FORMATS:
                raise serializers.ValidationError(
                    {"anchor_value": "Face masks need an image (PNG, JPG or WebP)."}
                )

        return attrs


def _item_payload(request, item):
    target = item.target_image
    asset = item.model_asset
    anchor_type = getattr(item, "anchor_type", "image")
    if not asset or (anchor_type == "image" and not target):
        return None
    return {
        "id": str(item.id),
        "name": item.name,
        "is_active": getattr(item, "is_active", True),
        "anchor": {"type": anchor_type, "value": getattr(item, "anchor_value", "")},
        "target": target and {
            "id": str(target.id),
            "name": target.name,
            "image_url": request.build_absolute_uri(target.image.url),
            "width": target.target_width,
        },
        "model": {
            "id": str(asset.id),
            "name": asset.name,
            "url": request.build_absolute_uri(asset.model_file.url),
            "format": asset.format,
        },
        "transform": {
            "position": [item.position_x, item.position_y, item.position_z],
            "rotation": [item.rotation_x, item.rotation_y, item.rotation_z],
            "scale": item.scale,
            "scale_xyz": [item.scale_x, item.scale_y, item.scale_z],
        },
        "animation": getattr(item, "animation", None),
        "behaviors": getattr(item, "behaviors", None),
    }


def build_scene_snapshot(request, experience):
    rows = list(
        experience.items.select_related("target_image", "model_asset").filter(is_active=True)
    )
    payloads = [p for p in (_item_payload(request, item) for item in rows) if p]
    if not payloads and experience.target_image_id and experience.model_asset_id:
        legacy = _item_payload(request, experience)
        if legacy:
            payloads = [legacy]
    return {
        "name": experience.name,
        "item_count": len(payloads),
        "items": payloads,
        "game": game_payload(experience.project),
        **project_extras(request, experience.project),
    }


class ARExperienceSerializer(serializers.ModelSerializer):
    published_slug = serializers.SerializerMethodField()
    items = serializers.SerializerMethodField()

    class Meta:
        model = ARExperience
        fields = [
            "id", "project", "name", "target_image", "model_asset", "status",
            "position_x", "position_y", "position_z",
            "rotation_x", "rotation_y", "rotation_z",
            "scale", "scale_x", "scale_y", "scale_z",
            "items",
            "published_slug",
            "created_at", "updated_at",
        ]
        read_only_fields = ["id", "created_at", "updated_at", "published_slug"]

    def get_items(self, obj):
        items = list(obj.items.all())
        if not items and obj.target_image_id and obj.model_asset_id:
            item, _ = ExperienceItem.objects.get_or_create(
                experience=obj,
                target_image_id=obj.target_image_id,
                model_asset_id=obj.model_asset_id,
                defaults={
                    "name": obj.name or getattr(obj.model_asset, "name", ""),
                    "order": 0,
                    "position_x": obj.position_x,
                    "position_y": obj.position_y,
                    "position_z": obj.position_z,
                    "rotation_x": obj.rotation_x,
                    "rotation_y": obj.rotation_y,
                    "rotation_z": obj.rotation_z,
                    "scale": obj.scale,
                    "scale_x": obj.scale_x,
                    "scale_y": obj.scale_y,
                    "scale_z": obj.scale_z,
                },
            )
            items = [item]
        return ExperienceItemSerializer(items, many=True, context=self.context).data

    def get_published_slug(self, obj):
        published = getattr(obj, "published_experience", None)
        if published and published.is_active:
            return published.slug or str(published.public_id)
        return None

    def validate(self, attrs):
        request = self.context.get("request")
        project = attrs.get(
            "project",
            getattr(self.instance, "project", None),
        )
        target = attrs.get(
            "target_image",
            getattr(self.instance, "target_image", None),
        )
        asset = attrs.get(
            "model_asset",
            getattr(self.instance, "model_asset", None),
        )
        if "scale" in attrs and not any(
            key in attrs for key in ("scale_x", "scale_y", "scale_z")
        ):
            attrs["scale_x"] = attrs["scale"]
            attrs["scale_y"] = attrs["scale"]
            attrs["scale_z"] = attrs["scale"]

        scales = {
            axis: attrs.get(axis, getattr(self.instance, axis, 1.0))
            for axis in ("scale_x", "scale_y", "scale_z")
        }
        if any(value <= 0 for value in scales.values()):
            raise serializers.ValidationError(
                {"scale": "Scale values must be greater than zero."}
            )

        attrs["scale"] = sum(scales.values()) / 3

        if request and project and project.user_id != request.user.id:
            raise serializers.ValidationError(
                {"project": "You do not own this project."}
            )

        if project and target and target.project_id != project.id:
            raise serializers.ValidationError(
                {"target_image": "Target must belong to this project."}
            )

        if project and asset and asset.project_id != project.id:
            raise serializers.ValidationError(
                {"model_asset": "Model must belong to this project."}
            )

        return attrs

    def create(self, validated_data):
        # Experiences created with the legacy single pair get a matching first
        # item, so every experience is a (possibly one-element) scene.
        legacy_target = validated_data.get("target_image")
        legacy_asset = validated_data.get("model_asset")

        experience = ARExperience.objects.create(**validated_data)

        if legacy_target and legacy_asset and not experience.items.exists():
            ExperienceItem.objects.create(
                experience=experience,
                target_image=legacy_target,
                model_asset=legacy_asset,
                name=experience.name,
                order=0,
                position_x=experience.position_x,
                position_y=experience.position_y,
                position_z=experience.position_z,
                rotation_x=experience.rotation_x,
                rotation_y=experience.rotation_y,
                rotation_z=experience.rotation_z,
                scale=experience.scale,
                scale_x=experience.scale_x,
                scale_y=experience.scale_y,
                scale_z=experience.scale_z,
            )

        return experience
