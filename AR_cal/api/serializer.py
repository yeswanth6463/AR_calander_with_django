
from rest_framework import serializers

from .models import Project, TargetImage, ModelAsset, ARExperience, ExperienceItem


class ProjectSerializer(serializers.ModelSerializer):
    class Meta:
        model = Project
        fields = [
            "id", "name", "slug", "description",
            "is_active", "created_at", "updated_at",
        ]
        read_only_fields = ["id", "slug", "created_at", "updated_at"]


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


class ExperienceItemSerializer(serializers.ModelSerializer):
    class Meta:
        model = ExperienceItem
        fields = [
            "id", "experience", "target_image", "model_asset", "name",
            "order", "is_active",
            "position_x", "position_y", "position_z",
            "rotation_x", "rotation_y", "rotation_z",
            "scale", "scale_x", "scale_y", "scale_z",
            "created_at", "updated_at",
        ]
        read_only_fields = ["id", "order", "created_at", "updated_at"]

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

        return attrs


def _item_payload(request, item):
    target = item.target_image
    asset = item.model_asset
    return {
        "id": str(item.id),
        "name": item.name,
        "target": {
            "name": target.name,
            "image_url": request.build_absolute_uri(target.image.url),
            "width": target.target_width,
        },
        "model": {
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
