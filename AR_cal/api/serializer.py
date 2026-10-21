
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


class ARExperienceSerializer(serializers.ModelSerializer):
    published_slug = serializers.SerializerMethodField()

    class Meta:
        model = ARExperience
        fields = [
            "id", "project", "name", "target_image", "model_asset", "status",
            "position_x", "position_y", "position_z",
            "rotation_x", "rotation_y", "rotation_z", "scale",
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
        scale = attrs.get(
            "scale",
            getattr(self.instance, "scale", 1.0),
        )

        if scale <= 0:
            raise serializers.ValidationError(
                {"scale": "Scale must be greater than zero."}
            )

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
