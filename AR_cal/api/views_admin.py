from django.db.models import Sum, Count
from rest_framework import status
from rest_framework.decorators import api_view, permission_classes
from rest_framework.response import Response

from .models import User, Organization, Project, ModelAsset, ARExperience
from .permissions import IsPlatformAdmin, IsSuperAdmin, IsContentAdmin


@api_view(["GET"])
@permission_classes([IsPlatformAdmin])
def admin_dashboard_overview(request):
    """
    Overview KPIs across the platform: users, orgs, projects, storage, assets.
    """
    total_users = User.objects.count()
    active_users = User.objects.filter(is_active=True).count()
    total_organizations = Organization.objects.count()
    active_organizations = Organization.objects.filter(is_active=True).count()

    total_projects = Project.objects.count()
    active_projects = Project.objects.filter(is_active=True).count()
    
    total_assets = ModelAsset.objects.count()
    shared_assets = ModelAsset.objects.filter(is_shared=True, approval_status="approved").count()
    pending_assets = ModelAsset.objects.filter(approval_status="pending").count()

    total_storage = (
        ModelAsset.objects.aggregate(total=Sum("file_size_bytes"))["total"] or 0
    )

    # Recent activity logs (recent users & projects)
    recent_users = [
        {
            "id": str(u.id),
            "email": u.email,
            "role": u.role,
            "customer_type": u.customer_type,
            "created_at": u.date_joined.isoformat() if u.date_joined else None,
        }
        for u in User.objects.order_by("-date_joined")[:5]
    ]

    recent_projects = [
        {
            "id": str(p.id),
            "name": p.name,
            "user_email": p.user.email if p.user else None,
            "organization_name": p.organization.name if p.organization else None,
            "project_type": p.project_type,
            "created_at": p.created_at.isoformat() if p.created_at else None,
        }
        for p in Project.objects.select_related("user", "organization").order_by("-created_at")[:5]
    ]

    return Response({
        "metrics": {
            "total_users": total_users,
            "active_users": active_users,
            "total_organizations": total_organizations,
            "active_organizations": active_organizations,
            "total_projects": total_projects,
            "active_projects": active_projects,
            "total_assets": total_assets,
            "shared_assets": shared_assets,
            "pending_assets": pending_assets,
            "total_storage_bytes": total_storage,
        },
        "recent_users": recent_users,
        "recent_projects": recent_projects,
    })


@api_view(["GET"])
@permission_classes([IsSuperAdmin])
def admin_users_list(request):
    """
    List registered platform users with storage and role filters.
    """
    users = User.objects.order_by("-date_joined")
    search = request.query_params.get("search", "").strip()
    if search:
        users = users.filter(email__icontains=search)

    role_filter = request.query_params.get("role", "").strip()
    if role_filter:
        users = users.filter(role=role_filter)

    data = [
        {
            "id": str(u.id),
            "email": u.email,
            "username": u.username,
            "first_name": u.first_name,
            "last_name": u.last_name,
            "role": u.role,
            "customer_type": u.customer_type,
            "storage_used_bytes": u.storage_used_bytes,
            "is_active": u.is_active,
            "date_joined": u.date_joined.isoformat() if u.date_joined else None,
            "last_login": u.last_login.isoformat() if u.last_login else None,
        }
        for u in users[:100]
    ]
    return Response({"users": data})


@api_view(["PATCH"])
@permission_classes([IsSuperAdmin])
def admin_user_update_role(request, user_id):
    """
    Update a user's role or status. Super Admin only.
    """
    try:
        user = User.objects.get(id=user_id)
    except User.DoesNotExist:
        return Response({"error": "User not found."}, status=status.HTTP_404_NOT_FOUND)

    role = request.data.get("role")
    if role in dict(User.ROLE_CHOICES):
        user.role = role

    is_active = request.data.get("is_active")
    if isinstance(is_active, bool):
        user.is_active = is_active

    customer_type = request.data.get("customer_type")
    if customer_type in dict(User.CUSTOMER_TYPE_CHOICES):
        user.customer_type = customer_type

    user.save()
    return Response({
        "id": str(user.id),
        "email": user.email,
        "role": user.role,
        "is_active": user.is_active,
        "customer_type": user.customer_type,
    })


@api_view(["GET", "POST"])
@permission_classes([IsSuperAdmin])
def admin_organizations_view(request):
    """
    List organizations or create a new enterprise organization.
    """
    if request.method == "POST":
        name = request.data.get("name", "").strip()
        owner_id = request.data.get("owner_id")
        if not name:
            return Response({"error": "Organization name is required."}, status=status.HTTP_400_BAD_REQUEST)
        
        try:
            owner = User.objects.get(id=owner_id) if owner_id else request.user
        except User.DoesNotExist:
            return Response({"error": "Owner user not found."}, status=status.HTTP_404_NOT_FOUND)

        org = Organization.objects.create(name=name, owner=owner)
        return Response({
            "id": str(org.id),
            "name": org.name,
            "slug": org.slug,
            "owner_email": org.owner.email,
            "is_active": org.is_active,
            "storage_limit_bytes": org.storage_limit_bytes,
            "storage_used_bytes": org.storage_used_bytes,
        }, status=status.HTTP_201_CREATED)

    orgs = Organization.objects.select_related("owner").annotate(
        member_count=Count("members"),
        project_count=Count("projects")
    ).order_by("-created_at")

    data = [
        {
            "id": str(o.id),
            "name": o.name,
            "slug": o.slug,
            "owner_email": o.owner.email,
            "is_active": o.is_active,
            "storage_limit_bytes": o.storage_limit_bytes,
            "storage_used_bytes": o.storage_used_bytes,
            "member_count": o.member_count,
            "project_count": o.project_count,
            "created_at": o.created_at.isoformat(),
        }
        for o in orgs
    ]
    return Response({"organizations": data})


@api_view(["GET"])
@permission_classes([IsSuperAdmin])
def admin_projects_list(request):
    """
    List all AR projects across all users and organizations.
    """
    projects = Project.objects.select_related("user", "organization").order_by("-created_at")
    data = [
        {
            "id": str(p.id),
            "name": p.name,
            "slug": p.slug,
            "project_type": p.project_type,
            "is_active": p.is_active,
            "user_email": p.user.email if p.user else None,
            "organization_name": p.organization.name if p.organization else None,
            "created_at": p.created_at.isoformat(),
            "updated_at": p.updated_at.isoformat(),
        }
        for p in projects[:150]
    ]
    return Response({"projects": data})


@api_view(["GET", "POST"])
@permission_classes([IsContentAdmin])
def admin_assets_moderation(request):
    """
    Review submitted 3D models for shared library marketplace.
    """
    if request.method == "POST":
        asset_id = request.data.get("asset_id")
        action = request.data.get("action")  # 'approve' or 'reject'
        try:
            asset = ModelAsset.objects.get(id=asset_id)
        except ModelAsset.DoesNotExist:
            return Response({"error": "Asset not found."}, status=status.HTTP_404_NOT_FOUND)

        if asset.approval_status == "private" and action != "approve":
            return Response({"error": "Cannot reject private assets that have not been submitted for review."}, status=status.HTTP_400_BAD_REQUEST)

        if action == "approve":
            asset.approval_status = "approved"
            asset.is_shared = True
        elif action == "reject":
            asset.approval_status = "rejected"
            asset.is_shared = False
        else:
            return Response({"error": "Invalid action. Use 'approve' or 'reject'."}, status=status.HTTP_400_BAD_REQUEST)

        asset.save()
        return Response({"id": str(asset.id), "name": asset.name, "approval_status": asset.approval_status})

    status_filter = request.query_params.get("status", "pending")
    assets = ModelAsset.objects.filter(approval_status=status_filter).select_related("project").order_by("-created_at")
    data = [
        {
            "id": str(a.id),
            "name": a.name,
            "format": a.format,
            "file_size_bytes": a.file_size_bytes,
            "approval_status": a.approval_status,
            "is_shared": a.is_shared,
            "project_name": a.project.name if a.project else None,
            "created_at": a.created_at.isoformat(),
        }
        for a in assets
    ]
    return Response({"assets": data})
