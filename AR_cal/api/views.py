from django.db import transaction
from rest_framework import viewsets, status
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from django.shortcuts import get_object_or_404

from .models import Project, TargetImage, ModelAsset, ARExperience, ExperienceItem
from .serializer import (
    ProjectSerializer,
    TargetImageSerializer,
    ModelAssetSerializer,
    ARExperienceSerializer,
    ExperienceItemSerializer,
)
from django.http import HttpResponse
from .service.image_tracker import track_target_image
from .service.target_bundle import compile_project_targets, compile_status
from .service.target_compiler import (
    TargetCompileError,
    compile_target,
    generate_feature_preview_image,
)


def _by_project(queryset, request):
    project = request.query_params.get("project")
    if project:
        queryset = queryset.filter(project_id=project)
    return queryset


class ProjectViewSet(viewsets.ModelViewSet):
    serializer_class = ProjectSerializer
    permission_classes = [IsAuthenticated]

    def get_queryset(self):
        return Project.objects.filter(user=self.request.user)

    def perform_create(self, serializer):
        serializer.save(user=self.request.user)


class TargetImageViewSet(viewsets.ModelViewSet):
    serializer_class = TargetImageSerializer
    permission_classes = [IsAuthenticated]

    def get_queryset(self):
        return _by_project(
            TargetImage.objects.filter(project__user=self.request.user),
            self.request,
        )

    def perform_create(self, serializer):
        serializer.save()

    def perform_destroy(self, instance):
        with transaction.atomic():
            ExperienceItem.objects.filter(target_image=instance).delete()
            ARExperience.objects.filter(target_image=instance).update(target_image=None)
            instance.delete()


class ModelAssetViewSet(viewsets.ModelViewSet):
    serializer_class = ModelAssetSerializer
    permission_classes = [IsAuthenticated]

    def get_queryset(self):
        return _by_project(
            ModelAsset.objects.filter(project__user=self.request.user),
            self.request,
        )

    def perform_destroy(self, instance):
        with transaction.atomic():
            ExperienceItem.objects.filter(model_asset=instance).delete()
            ARExperience.objects.filter(model_asset=instance).update(model_asset=None)
            instance.delete()


class ARExperienceViewSet(viewsets.ModelViewSet):
    serializer_class = ARExperienceSerializer
    permission_classes = [IsAuthenticated]

    def get_queryset(self):
        return _by_project(
            ARExperience.objects.filter(project__user=self.request.user)
            .prefetch_related("items"),
            self.request,
        )


class ExperienceItemViewSet(viewsets.ModelViewSet):
    serializer_class = ExperienceItemSerializer
    permission_classes = [IsAuthenticated]

    def get_queryset(self):
        queryset = ExperienceItem.objects.filter(
            experience__project__user=self.request.user
        ).select_related("experience", "target_image", "model_asset")
        experience = self.request.query_params.get("experience")
        if experience:
            queryset = queryset.filter(experience_id=experience)
        return queryset

    def perform_create(self, serializer):
        experience = serializer.validated_data["experience"]
        order = serializer.validated_data.get("order")
        if order is None:
            order = ExperienceItem.objects.filter(experience=experience).count()
        serializer.save(order=order)


@api_view(["GET", "POST"])
@permission_classes([IsAuthenticated])
def compile_targets(request, project_id):
    """GET: compile status. POST: compile all target images into one bundle."""
    project = get_object_or_404(Project, id=project_id, user=request.user)
    if request.method == "GET":
        return Response(compile_status(project))
    result = compile_project_targets(project)
    targets = [
        {
            "id": str(t.id),
            "name": t.name,
            **{
                k: v
                for k, v in (t.tracking_data or {}).items()
                if k != "rich_keypoints"
            },
        }
        for t in project.target_images.filter(is_active=True).order_by("created_at", "id")
    ]
    return Response({**result, "targets": targets})


@api_view(["POST"])
@permission_classes([IsAuthenticated])
def register_target(request, target_id):
    """Legacy per-target "Register": compiles the whole project bundle."""
    target = get_object_or_404(
        TargetImage,
        id=target_id,
        project__user=request.user,
        is_active=True,
    )
    compile_project_targets(target.project)
    target.refresh_from_db(fields=["tracking_data"])
    data = target.tracking_data or {}
    if data.get("status") != "ready":
        return Response(
            {"error": data.get("error") or "Target could not be compiled."},
            status=status.HTTP_400_BAD_REQUEST,
        )
    return Response({
        "message": "Target compiled successfully.",
        "target_id": str(target.id),
        "feature_count": data.get("feature_count", 0),
        "index": data.get("index"),
        "rating": data.get("rating"),
    })


@api_view(["GET"])
@permission_classes([IsAuthenticated])
def target_features(request, target_id):
    target = get_object_or_404(
        TargetImage,
        id=target_id,
        project__user=request.user,
        is_active=True,
    )
    if not target.image:
        return Response({"error": "Target image is missing."}, status=status.HTTP_400_BAD_REQUEST)

    if request.query_params.get("format") == "image":
        try:
            png_bytes, _count = generate_feature_preview_image(target.image.path)
            return HttpResponse(png_bytes, content_type="image/png")
        except (TargetCompileError, OSError):
            return Response({"error": "Unable to read target image."}, status=status.HTTP_400_BAD_REQUEST)

    # Same pipeline as the compiler, so the preview shows what is tracked.
    try:
        quality = compile_target(target.image.path)["quality"]
    except (TargetCompileError, OSError):
        return Response({"error": "Unable to read target image."}, status=status.HTTP_400_BAD_REQUEST)
    return Response({
        "target_id": str(target.id),
        "name": target.name,
        "width": quality["source_width"],
        "height": quality["source_height"],
        "feature_count": quality["feature_count"],
        "spread": quality["spread"],
        "rating": quality["rating"],
        "rating_text": quality["rating_text"],
        "rich_keypoints": quality["rich_keypoints"],
        "preview_url": f"/api/targets/{target.id}/features/?format=image",
    })


@api_view(["POST"])
@permission_classes([IsAuthenticated])
def track_image(request, target_id):
    target = get_object_or_404(
        TargetImage,
        id=target_id,
        project__user=request.user,
        is_active=True,
    )

    frame = request.FILES.get("frame")

    if frame is None:
        return Response(
            {"error": "Provide a camera frame in the 'frame' field."},
            status=status.HTTP_400_BAD_REQUEST,
        )

    if frame.size > 8 * 1024 * 1024:
        return Response(
            {"error": "Frame must be 8 MB or smaller."},
            status=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
        )

    if not target.image:
        return Response(
            {"error": "Target image is missing."},
            status=status.HTTP_400_BAD_REQUEST,
        )

    try:
        # tracking_data now holds compiler quality metadata, not raw
        # descriptors, so features are extracted fresh here.
        result = track_target_image(target.image.path, frame.read())
    except (ValueError, OSError) as exc:
        return Response(
            {"error": str(exc)},
            status=status.HTTP_400_BAD_REQUEST,
        )

    return Response(result, status=status.HTTP_200_OK)
