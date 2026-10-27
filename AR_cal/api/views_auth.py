from django.contrib.auth import authenticate, login, logout
from django.contrib.auth.decorators import login_required
from django.core.exceptions import ValidationError as DjangoValidationError
from django.core.validators import validate_slug
from django.utils.decorators import method_decorator
from django.views.decorators.csrf import ensure_csrf_cookie

from rest_framework import status
from rest_framework.decorators import (
    api_view,
    authentication_classes,
    permission_classes,
    parser_classes,
)
from rest_framework.parsers import FormParser, JSONParser, MultiPartParser
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from .models import ARExperience, ExperienceItem, PublishedExperience, User
from .serializer import _item_payload, build_scene_snapshot


def user_payload(user):
    return {
        "id": str(user.id),
        "email": user.email,
        "username": user.username,
        "first_name": user.first_name,
        "last_name": user.last_name,
    }


@method_decorator(ensure_csrf_cookie, name="dispatch")
class CSRFView(APIView):
    permission_classes = [AllowAny]

    def get(self, request):
        return Response({"detail": "CSRF cookie set."})


@api_view(["POST"])
@authentication_classes([])
@permission_classes([AllowAny])
@parser_classes([JSONParser])
def register(request):
    email = (request.data.get("email") or "").strip().lower()
    password = request.data.get("password") or ""
    username = (request.data.get("username") or email).strip()

    if not email or "@" not in email:
        return Response({"error": "A valid email is required."}, status=400)
    if len(password) < 8:
        return Response({"error": "Password must be at least 8 characters."}, status=400)
    if User.objects.filter(email=email).exists():
        return Response({"error": "An account with this email already exists."}, status=400)

    user = User.objects.create_user(
        username=username, email=email, password=password
    )
    login(request, user)
    return Response({"user": user_payload(user)}, status=status.HTTP_201_CREATED)


@api_view(["POST"])
@authentication_classes([])
@permission_classes([AllowAny])
@parser_classes([JSONParser])
def login_view(request):
    email = (request.data.get("email") or "").strip().lower()
    password = request.data.get("password") or ""

    # Resolve the account by email first — usernames may differ from email.
    user_obj = User.objects.filter(email=email).first()
    user = (
        authenticate(request, username=user_obj.username, password=password)
        if user_obj
        else None
    )
    if user is None:
        return Response({"error": "Invalid email or password."}, status=401)
    login(request, user)
    return Response({"user": user_payload(user)})


@api_view(["POST"])
@permission_classes([IsAuthenticated])
def logout_view(request):
    logout(request)
    return Response({"detail": "Logged out."})


@api_view(["GET"])
@permission_classes([IsAuthenticated])
def me(request):
    return Response({"user": user_payload(request.user)})


@api_view(["POST"])
@permission_classes([IsAuthenticated])
@parser_classes([MultiPartParser, FormParser, JSONParser])
def publish_experience(request, experience_id):
    try:
        experience = ARExperience.objects.select_related(
            "target_image", "model_asset"
        ).get(id=experience_id, project__user=request.user)
    except ARExperience.DoesNotExist:
        return Response({"error": "Experience not found."}, status=404)

    # Legacy single-pair experiences without a mirrored item yet: sync now.
    if (
        experience.target_image
        and experience.model_asset
        and not experience.items.exists()
    ):
        ExperienceItem.objects.create(
            experience=experience,
            target_image=experience.target_image,
            model_asset=experience.model_asset,
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

    if not experience.items.exists() and not (
        experience.target_image and experience.model_asset
    ):
        return Response(
            {"error": "Experience needs at least one target image and 3D model."},
            status=400,
        )

    slug = (request.data.get("slug") or "").strip().lower() if hasattr(request.data, "get") else ""
    if slug:
        try:
            validate_slug(slug)
        except DjangoValidationError:
            return Response(
                {"error": "Link name may only contain letters, numbers, hyphens and underscores."},
                status=400,
            )
        if PublishedExperience.objects.filter(slug=slug).exclude(experience=experience).exists():
            return Response(
                {"error": f'The link name "{slug}" is already taken.'},
                status=400,
            )

    published, created = PublishedExperience.objects.get_or_create(
        experience=experience
    )
    if slug:
        published.slug = slug
    if not created:
        published.version += 1
        published.is_active = True
    published.scene_snapshot = build_scene_snapshot(request, experience)
    published.save()

    experience.status = "published"
    experience.save(update_fields=["status", "updated_at"])

    link = published.slug or str(published.public_id)
    return Response(
        {
            "public_id": str(published.public_id),
            "slug": published.slug,
            "version": published.version,
            "item_count": len((published.scene_snapshot or {}).get("items") or []),
            "url": f"/view/{link}",
        },
        status=201 if created else 200,
    )


@api_view(["POST"])
@permission_classes([IsAuthenticated])
def unpublish_experience(request, experience_id):
    try:
        experience = ARExperience.objects.get(
            id=experience_id, project__user=request.user
        )
    except ARExperience.DoesNotExist:
        return Response({"error": "Experience not found."}, status=404)

    PublishedExperience.objects.filter(experience=experience).update(is_active=False)
    experience.status = "draft"
    experience.save(update_fields=["status", "updated_at"])
    return Response({"detail": "Experience unpublished."})


@api_view(["GET"])
@authentication_classes([])
@permission_classes([AllowAny])
def public_experience(request, public_id):
    import uuid as uuid_lib

    published = None
    try:
        public_uuid = uuid_lib.UUID(str(public_id))
        published = PublishedExperience.objects.filter(
            public_id=public_uuid, is_active=True
        ).first()
    except ValueError:
        published = None

    if published is None:
        published = PublishedExperience.objects.filter(
            slug=str(public_id).lower(), is_active=True
        ).first()

    if published is None:
        return Response({"error": "Experience not found."}, status=404)

    published = PublishedExperience.objects.select_related(
        "experience__project",
        "experience__target_image",
        "experience__model_asset",
    ).get(id=published.id)

    exp = published.experience
    target = exp.target_image
    asset = exp.model_asset

    snapshot = published.scene_snapshot if isinstance(published.scene_snapshot, dict) else None
    items = list((snapshot or {}).get("items") or [])
    if not items:
        items = [
            payload
            for payload in (
                _item_payload(request, item)
                for item in exp.items.select_related(
                    "target_image", "model_asset"
                ).filter(is_active=True)
            )
            if payload
        ]

    if not items and target and asset:
        # Legacy pair not mirrored into items yet — expose it as a one-item scene.
        legacy = _item_payload(request, exp)
        items = [legacy] if legacy else []

    first = items[0] if items else None

    # Legacy top-level keys: keep the original shape for already-published
    # links; fall back to the first item for scenes authored without the
    # legacy single pair.
    top_target = target and {
        "name": target.name,
        "image_url": request.build_absolute_uri(target.image.url),
        "width": target.target_width,
    }
    top_model = asset and {
        "name": asset.name,
        "url": request.build_absolute_uri(asset.model_file.url),
        "format": asset.format,
    }
    if not top_target and first:
        top_target = first["target"]
    if not top_model and first:
        top_model = first["model"]

    if target and asset:
        top_transform = {
            "position": [exp.position_x, exp.position_y, exp.position_z],
            "rotation": [exp.rotation_x, exp.rotation_y, exp.rotation_z],
            "scale": exp.scale,
            "scale_xyz": [exp.scale_x, exp.scale_y, exp.scale_z],
        }
    else:
        top_transform = first["transform"] if first else {
            "position": [0.0, 0.0, 0.0],
            "rotation": [0.0, 0.0, 0.0],
            "scale": 1.0,
            "scale_xyz": [1.0, 1.0, 1.0],
        }

    return Response(
        {
            "public_id": str(published.public_id),
            "slug": published.slug,
            "name": exp.name,
            "version": published.version,
            "published_at": published.published_at,
            "project": exp.project.name,
            "target": top_target,
            "model": top_model,
            "transform": top_transform,
            "item_count": len(items),
            "items": items,
        }
    )
