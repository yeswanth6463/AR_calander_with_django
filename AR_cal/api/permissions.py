from rest_framework.permissions import BasePermission

class IsSuperAdmin(BasePermission):
    """Platform-wide administration only."""
    def has_permission(self, request, view):
        user = request.user
        return bool(
            user
            and user.is_authenticated
            and (user.is_superuser or getattr(user, "role", "") == "super_admin")
        )

class IsFinanceAdmin(BasePermission):
    """Finance-related access only (Super Admin + Finance Admin)."""
    def has_permission(self, request, view):
        user = request.user
        return bool(
            user
            and user.is_authenticated
            and (
                user.is_superuser
                or getattr(user, "role", "") in ["super_admin", "finance_admin"]
            )
        )

class IsContentAdmin(BasePermission):
    """Asset and marketplace moderation (Super Admin + Content Admin)."""
    def has_permission(self, request, view):
        user = request.user
        return bool(
            user
            and user.is_authenticated
            and (
                user.is_superuser
                or getattr(user, "role", "") in ["super_admin", "content_admin"]
            )
        )

class IsSupportAdmin(BasePermission):
    """Support-related access only (Super Admin + Support Admin)."""
    def has_permission(self, request, view):
        user = request.user
        return bool(
            user
            and user.is_authenticated
            and (
                user.is_superuser
                or getattr(user, "role", "") in ["super_admin", "support_admin"]
            )
        )

class IsPlatformAdmin(BasePermission):
    """
    General read-only overview access for any authenticated platform staff.
    """
    def has_permission(self, request, view):
        user = request.user
        if not user or not user.is_authenticated:
            return False
        if user.is_superuser:
            return True
        return getattr(user, "role", "") in [
            "super_admin",
            "finance_admin",
            "content_admin",
            "support_admin",
        ]
