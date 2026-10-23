
from rest_framework import serializers

from .models import Project, TargetImage, ModelAsset, ARExperience


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


class ARExperienceSerializer(serializers.ModelSerializer):
    published_slug = serializers.SerializerMethodField()

    class Meta:
        model = ARExperience
        fields = [
            "id", "project", "name", "target_image", "model_asset", "status",
            "position_x", "position_y", "position_z",
            "rotation_x", "rotation_y", "rotation_z",
            "scale", "scale_x", "scale_y", "scale_z",
            "published_slug",
            "created_at", "updated_at",
        ]
        read_only_fields = ["id", "created_at", "updated_at", "published_slug"]

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
