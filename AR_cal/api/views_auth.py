from django.contrib.auth import authenticate, login, logout
from django.contrib.auth.decorators import login_required
from django.core.exceptions import ValidationError as DjangoValidationError
from django.core.validators import validate_slug
from django.db import IntegrityError
from django.utils.decorators import method_decorator
from django.views.decorators.csrf import ensure_csrf_cookie

from rest_framework import status
from rest_framework.decorators import (
    api_view,
    authentication_classes,
    permission_classes,
    parser_classes,
    throttle_classes,
)
from rest_framework.parsers import FormParser, JSONParser, MultiPartParser
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response
from rest_framework.throttling import AnonRateThrottle
from rest_framework.views import APIView


class LoginRateThrottle(AnonRateThrottle):
    """Per-IP limit on login attempts (rate in DEFAULT_THROTTLE_RATES['login'])."""

    scope = "login"


class RegisterRateThrottle(AnonRateThrottle):
    """Per-IP limit on account creation (rate in DEFAULT_THROTTLE_RATES['register'])."""

    scope = "register"

from .models import ARExperience, ExperienceItem, Project, ProjectPublication, PublishedExperience, User
from .serializer import (
    _item_payload,
    available_models_payload,
    build_scene_snapshot,
    game_payload,
    project_extras,
)
from .service.target_bundle import ensure_compiled


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
@throttle_classes([RegisterRateThrottle])
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
        return Response({"error": "An account with this email already exists. Please sign in."}, status=400)
    if User.objects.filter(username=username).exists():
        return Response({"error": f"The username '{username}' is already taken. Please choose another username."}, status=400)

    try:
        user = User.objects.create_user(
            username=username, email=email, password=password
        )
    except IntegrityError as exc:
        err_msg = str(exc).lower()
        if "username" in err_msg:
            return Response({"error": f"The username '{username}' is already taken. Please choose another username."}, status=400)
        elif "email" in err_msg:
            return Response({"error": "An account with this email already exists. Please sign in."}, status=400)
        return Response({"error": "Could not create account with the provided details."}, status=400)
    except Exception as exc:
        return Response({"error": str(exc)}, status=400)

    login(request, user)
    return Response({"user": user_payload(user)}, status=status.HTTP_201_CREATED)


@api_view(["POST"])
@authentication_classes([])
@permission_classes([AllowAny])
@throttle_classes([LoginRateThrottle])
@parser_classes([JSONParser])
def login_view(request):
    identifier = (request.data.get("email") or "").strip()
    identifier_lower = identifier.lower()
    password = request.data.get("password") or ""

    # Resolve account by email or username
    user_obj = (
        User.objects.filter(email=identifier_lower).first()
        or User.objects.filter(username=identifier).first()
        or User.objects.filter(username=identifier_lower).first()
    )
    user = (
        authenticate(request, username=user_obj.username, password=password)
        if user_obj
        else None
    )
    if user is None:
        return Response({"error": "Invalid email/username or password."}, status=401)
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

    ensure_compiled(experience.project)
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


def _slug_taken(slug, publication=None):
    pubs = ProjectPublication.objects.filter(slug=slug)
    if publication is not None:
        pubs = pubs.exclude(pk=publication.pk)
    if pubs.exists():
        return True
    return PublishedExperience.objects.filter(slug=slug).exists()


@api_view(["POST"])
@permission_classes([IsAuthenticated])
@parser_classes([MultiPartParser, FormParser, JSONParser])
def publish_project(request, project_id):
    """Publish the checked scenes as one shareable experience."""
    try:
        project = Project.objects.get(id=project_id, user=request.user)
    except Project.DoesNotExist:
        return Response({"error": "Project not found."}, status=404)

    raw_ids = request.data.get("scene_ids") if hasattr(request.data, "get") else None
    if not isinstance(raw_ids, list) or not raw_ids:
        return Response(
            {"error": "Select at least one scene to publish."},
            status=400,
        )

    ordered = []
    seen = set()
    for value in raw_ids:
        key = str(value)
        if key in seen:
            continue
        seen.add(key)
        ordered.append(key)

    experiences = list(
        ARExperience.objects.filter(project=project, id__in=ordered).prefetch_related("items")
    )
    by_id = {str(exp.id): exp for exp in experiences}
    missing = [key for key in ordered if key not in by_id]
    if missing:
        return Response(
            {"error": "One or more scenes do not belong to this project."},
            status=400,
        )

    ensure_compiled(project)
    scenes = []
    for key in ordered:
        exp = by_id[key]
        if (
            exp.target_image_id
            and exp.model_asset_id
            and not exp.items.exists()
        ):
            ExperienceItem.objects.create(
                experience=exp,
                target_image=exp.target_image,
                model_asset=exp.model_asset,
                name=exp.name,
                order=0,
                position_x=exp.position_x,
                position_y=exp.position_y,
                position_z=exp.position_z,
                rotation_x=exp.rotation_x,
                rotation_y=exp.rotation_y,
                rotation_z=exp.rotation_z,
                scale=exp.scale,
                scale_x=exp.scale_x,
                scale_y=exp.scale_y,
                scale_z=exp.scale_z,
            )
        snap = build_scene_snapshot(request, exp)
        user_model_mode = (
            (project.type_settings or {}).get("mode") == "user_model"
        )
        if not snap["items"] and not user_model_mode:
            return Response(
                {"error": f'"{exp.name or "Untitled"}" has no target and model to publish.'},
                status=400,
            )
        scenes.append({
            "id": str(exp.id),
            "name": exp.name or "Untitled",
            "items": snap["items"],
        })

    slug = (request.data.get("slug") or "").strip().lower() if hasattr(request.data, "get") else ""
    publication = ProjectPublication.objects.filter(project=project).first()
    if slug:
        try:
            validate_slug(slug)
        except DjangoValidationError:
            return Response(
                {"error": "Link name may only contain letters, numbers, hyphens and underscores."},
                status=400,
            )
        if _slug_taken(slug, publication):
            return Response(
                {"error": f'The link name "{slug}" is already taken.'},
                status=400,
            )

    created = publication is None
    if created:
        publication = ProjectPublication(project=project)
    elif not slug:
        slug = publication.slug or ""
    if slug:
        publication.slug = slug
    if not created:
        publication.version += 1
        publication.is_active = True
    publication.scene_ids = [scene["id"] for scene in scenes]
    publication.scene_snapshot = {
        "name": project.name,
        "scene_count": len(scenes),
        "scenes": scenes,
        "game": game_payload(project),
        **project_extras(request, project),
    }
    publication.save()

    included = set(publication.scene_ids)
    ARExperience.objects.filter(project=project, id__in=included).update(status="published")
    own_published = set(
        PublishedExperience.objects.filter(
            experience__project=project, is_active=True
        ).values_list("experience_id", flat=True)
    )
    ARExperience.objects.filter(project=project, status="published").exclude(
        id__in=included
    ).exclude(id__in=own_published).update(status="draft")

    link = publication.slug or str(publication.public_id)
    return Response(
        {
            "success": True,
            "published_experience_id": str(publication.public_id),
            "slug": publication.slug,
            "version": publication.version,
            "scene_count": len(scenes),
            "scene_ids": publication.scene_ids,
            "share_url": request.build_absolute_uri(f"/view/{link}"),
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

    bundle = None
    try:
        public_uuid = uuid_lib.UUID(str(public_id))
        bundle = ProjectPublication.objects.filter(
            public_id=public_uuid, is_active=True
        ).select_related("project").first()
    except ValueError:
        bundle = None
    if bundle is None:
        bundle = ProjectPublication.objects.filter(
            slug=str(public_id).lower(), is_active=True
        ).select_related("project").first()
    if bundle is not None:
        snapshot = bundle.scene_snapshot if isinstance(bundle.scene_snapshot, dict) else {}
        scenes = list(snapshot.get("scenes") or [])
        all_items = []
        for s in scenes:
            all_items.extend(s.get("items") or [])
        first = all_items[0] if all_items else None
        project = bundle.project
        live_settings = project.type_settings if isinstance(project.type_settings, dict) else {}
        snapshot_settings = snapshot.get("type_settings") if isinstance(snapshot.get("type_settings"), dict) else {}
        type_settings = {**snapshot_settings, **live_settings}
        return Response(
            {
                "public_id": str(bundle.public_id),
                "slug": bundle.slug,
                "name": snapshot.get("name") or project.name,
                "version": bundle.version,
                "published_at": bundle.published_at,
                "project": project.name,
                "project_id": str(project.id),
                "target": first["target"] if first else None,
                "model": first["model"] if first else None,
                "transform": first["transform"] if first else None,
                "item_count": len(all_items),
                "items": all_items,
                "scene_count": len(scenes),
                "scene_ids": list(bundle.scene_ids or []),
                "scenes": scenes,
                "game": snapshot.get("game"),
                "project_type": snapshot.get("project_type") or project.project_type,
                "type_settings": type_settings,
                "mode": type_settings.get("mode") or "target_image",
                "available_models": available_models_payload(request, project),
                "sounds": snapshot.get("sounds") or [],
                "compiled_targets": snapshot.get("compiled_targets"),
            }
        )

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

    project = exp.project
    live_settings = project.type_settings if isinstance(project.type_settings, dict) else {}
    snapshot_settings = (snapshot or {}).get("type_settings")
    if not isinstance(snapshot_settings, dict):
        snapshot_settings = {}
    type_settings = {**snapshot_settings, **live_settings}

    return Response(
        {
            "public_id": str(published.public_id),
            "slug": published.slug,
            "name": exp.name,
            "version": published.version,
            "published_at": published.published_at,
            "project": project.name,
            "project_id": str(project.id),
            "target": top_target,
            "model": top_model,
            "transform": top_transform,
            "item_count": len(items),
            "items": items,
            "game": (snapshot or {}).get("game"),
            "project_type": (snapshot or {}).get("project_type") or project.project_type,
            "type_settings": type_settings,
            "mode": type_settings.get("mode") or "target_image",
            "available_models": available_models_payload(request, project),
            "sounds": (snapshot or {}).get("sounds") or [],
            "compiled_targets": (snapshot or {}).get("compiled_targets"),
            "scene_count": 1 if items else 0,
            "scene_ids": [str(exp.id)],
            "scenes": [
                {
                    "id": str(exp.id),
                    "name": exp.name or "Untitled",
                    "items": items,
                }
            ] if items else [],
        }
    )
