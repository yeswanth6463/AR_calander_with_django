from django.shortcuts import render

# Create your views here.

from rest_framework import viewsets, status
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from django.shortcuts import get_object_or_404

from .models import Project, TargetImage, ModelAsset, ARExperience
from .serializer import (
    ProjectSerializer,
    TargetImageSerializer,
    ModelAssetSerializer,
    ARExperienceSerializer,
)
from .service.image_tracker import (
    extract_target_features,
    track_target_image,
)


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
        return TargetImage.objects.filter(
            project__user=self.request.user
        )

    def perform_create(self, serializer):
        serializer.save()


class ModelAssetViewSet(viewsets.ModelViewSet):
    serializer_class = ModelAssetSerializer
    permission_classes = [IsAuthenticated]

    def get_queryset(self):
        return ModelAsset.objects.filter(
            project__user=self.request.user
        )


class ARExperienceViewSet(viewsets.ModelViewSet):
    serializer_class = ARExperienceSerializer
    permission_classes = [IsAuthenticated]

    def get_queryset(self):
        return ARExperience.objects.filter(
            project__user=self.request.user
        )


@api_view(["POST"])
@permission_classes([IsAuthenticated])
def register_target(request, target_id):
    target = get_object_or_404(
        TargetImage,
        id=target_id,
        project__user=request.user,
        is_active=True,
    )

    if not target.image:
        return Response(
            {"error": "Target image is missing."},
            status=status.HTTP_400_BAD_REQUEST,
        )

    try:
        features = extract_target_features(target.image.path)
    except (ValueError, OSError) as exc:
        return Response(
            {"error": str(exc)},
            status=status.HTTP_400_BAD_REQUEST,
        )

    target.tracking_data = features
    target.save(update_fields=["tracking_data", "updated_at"])

    return Response({
        "message": "Target features registered successfully.",
        "target_id": str(target.id),
        "feature_count": len(features["keypoints"]),
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
        if not target.tracking_data:
            target.tracking_data = extract_target_features(
                target.image.path
            )
            target.save(update_fields=["tracking_data", "updated_at"])

        result = track_target_image(
            target.image.path,
            frame.read(),
            cached_features=target.tracking_data,
        )
    except (ValueError, OSError) as exc:
        return Response(
            {"error": str(exc)},
            status=status.HTTP_400_BAD_REQUEST,
        )

    return Response(result, status=status.HTTP_200_OK)
